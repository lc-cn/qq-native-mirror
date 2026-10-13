/** SDK adapter port, not a declaration of any proprietary native ABI.
 * A binary-specific adapter must independently establish its argument and result codec. */
export interface PacketService {
  sendSsoCmdReqByContend(command: string, data: Buffer): unknown;
}
export type PacketTransportFailure =
  | 'input'
  | 'missing'
  | 'dispatch'
  | 'rejected'
  | 'envelope'
  | 'inspection'
  | 'canceled'
  | 'timeout';
export class PacketTransportError extends Error {
  readonly kind: PacketTransportFailure;
  readonly dispatched: boolean;
  readonly responseReceived: boolean;
  constructor(kind: PacketTransportFailure, dispatched = false, responseReceived = false) {
    super(`Packet transport ${kind}`);
    this.name = 'PacketTransportError';
    this.kind = kind;
    this.dispatched = dispatched;
    this.responseReceived = responseReceived;
  }
}
export interface PacketTransportOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  maxResponseBytes: number;
}
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const isAborted = (signal?: AbortSignal): boolean => signal !== undefined && aborted.call(signal);
const regularBuffer = (value: unknown): value is Buffer =>
  Buffer.isBuffer(value) && Object.getPrototypeOf(value) === Buffer.prototype;
/** Owns observation of one native round trip, never protocol decoding or retries. */
export function createPacketTransport(service: PacketService) {
  let closed = false;
  const outstanding = new Set<() => void>();
  const assertOpen = (signal?: AbortSignal): void => {
    if (closed || isAborted(signal)) throw new PacketTransportError('canceled');
  };
  return {
    assertOpen,
    request(command: string, input: Buffer, options: PacketTransportOptions): Promise<Buffer> {
      let signal: AbortSignal | undefined, timeout: number, maximum: number, request: Buffer;
      try {
        if (typeof command !== 'string' || !command || !regularBuffer(input)) throw Error();
        if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options)))
          throw Error();
        const own = (key: string): unknown => {
          const field = Object.getOwnPropertyDescriptor(options, key);
          if (!field) return undefined;
          if (!('value' in field)) throw Error();
          return field.value;
        };
        const capturedSignal = own('signal');
        if (capturedSignal !== undefined) {
          aborted.call(capturedSignal);
          signal = capturedSignal as AbortSignal;
        }
        const ms = own('timeoutMs'),
          limit = own('maxResponseBytes');
        if (
          typeof ms !== 'number' ||
          !Number.isSafeInteger(ms) ||
          ms < 1 ||
          ms > 60000 ||
          typeof limit !== 'number' ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 512 * 1024 * 1024
        )
          throw Error();
        timeout = ms;
        maximum = limit;
        assertOpen(signal);
        request = Buffer.from(input);
        assertOpen(signal);
      } catch {
        if (closed || (signal !== undefined && isAborted(signal)))
          return Promise.reject(new PacketTransportError('canceled'));
        return Promise.reject(new PacketTransportError('input'));
      }
      return new Promise((resolve, reject) => {
        let settled = false,
          dispatched = false,
          received = false;
        const timer: { handle?: ReturnType<typeof setTimeout> } = {};
        const failure = (kind: PacketTransportFailure) =>
          new PacketTransportError(kind, dispatched, received);
        const finish = (outcome: { value: Buffer } | { error: PacketTransportError }) => {
          if (settled) return;
          settled = true;
          if (timer.handle !== undefined) clearTimeout(timer.handle);
          if (signal) EventTarget.prototype.removeEventListener.call(signal, 'abort', cancel);
          outstanding.delete(cancel);
          if ('error' in outcome) reject(outcome.error);
          else resolve(outcome.value);
        };
        const cancel = () => finish({ error: failure('canceled') });
        const alive = () => {
          if (closed || isAborted(signal)) {
            cancel();
            return false;
          }
          return !settled;
        };
        outstanding.add(cancel);
        if (signal)
          EventTarget.prototype.addEventListener.call(signal, 'abort', cancel, { once: true });
        if (!alive()) return;
        timer.handle = setTimeout(() => finish({ error: failure('timeout') }), timeout);
        let returned: unknown;
        try {
          const method = service?.sendSsoCmdReqByContend;
          if (!alive()) return;
          if (typeof method !== 'function') {
            finish({ error: failure('missing') });
            return;
          }
          dispatched = true;
          returned = Reflect.apply(method, service, [command, request]);
        } catch {
          if (alive()) finish({ error: failure('dispatch') });
          return;
        }
        Promise.resolve(returned)
          .then(
            (value) => {
              if (!alive()) return;
              received = true;
              try {
                const prototype =
                  value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
                if (!alive()) return;
                const field =
                  prototype === Object.prototype || prototype === null
                    ? Object.getOwnPropertyDescriptor(value, 'rspbuffer')
                    : undefined;
                if (!alive()) return;
                const bytes: unknown = field && 'value' in field ? field.value : undefined;
                const valid = regularBuffer(bytes);
                if (!alive()) return;
                if (!valid || bytes.length === 0 || bytes.length > maximum) {
                  finish({ error: failure('envelope') });
                  return;
                }
                const copy = Buffer.from(bytes);
                if (alive()) finish({ value: copy });
              } catch {
                if (alive()) finish({ error: failure('inspection') });
              }
            },
            () => {
              if (alive()) finish({ error: failure('rejected') });
            },
          )
          .catch(() => {
            if (alive()) finish({ error: failure('inspection') });
          });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const cancel of [...outstanding]) cancel();
    },
  };
}
