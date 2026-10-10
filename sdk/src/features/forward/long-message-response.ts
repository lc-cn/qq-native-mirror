import { TextDecoder } from 'node:util';

// Fixed NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
// packet/transformer/proto/message/action.ts: SendLongMsgResp.result=2,
// SendLongMsgResult.resId=3; UploadForwardMsg.ts supplies this command.
export const LONG_MESSAGE_COMMAND = 'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg';
const MAX_WIRE = 1024 * 1024,
  MAX_RES_ID = 4096,
  MAX_DEPTH = 16;
export type LongMessageFailureStage = 'input' | 'lifecycle' | 'native' | 'response' | 'protobuf';
export class LongMessageResponseError extends Error {
  readonly stage: LongMessageFailureStage;
  readonly dispatched: boolean;
  readonly completion: 'not-dispatched' | 'unknown' | 'response-received';
  constructor(
    stage: LongMessageFailureStage,
    message: string,
    dispatched = false,
    completion: 'not-dispatched' | 'unknown' | 'response-received' = dispatched
      ? 'unknown'
      : 'not-dispatched',
  ) {
    super(message);
    this.name = 'LongMessageResponseError';
    this.stage = stage;
    this.dispatched = dispatched;
    this.completion = completion;
  }
}
function regularBuffer(value: unknown): value is Buffer {
  return Buffer.isBuffer(value) && Object.getPrototypeOf(value) === Buffer.prototype;
}
function fail(message: string): never {
  throw new LongMessageResponseError('protobuf', message);
}
/** Only decodes the pinned response schema. Limits and strictness are SDK policy. */
export function parseLongMessageResponse(input: Buffer): { resId: string } {
  if (!regularBuffer(input) || input.length === 0 || input.length > MAX_WIRE)
    fail('Invalid long-message response buffer');
  const bytes = Buffer.from(input);
  function scan(
    start: number,
    end: number,
    kind: 'response' | 'result' | 'unknown',
    depth: number,
    group?: number,
  ): { next: number; resId?: string } {
    if (depth > MAX_DEPTH) fail('Protobuf nesting limit exceeded');
    let at = start,
      found = false,
      resId: string | undefined;
    function varint(): bigint {
      let value = 0n;
      for (let i = 0; i < 10; i++) {
        if (at >= end) fail('Truncated protobuf varint');
        const byte = bytes[at++];
        if (i === 9 && byte > 1) fail('Protobuf varint exceeds uint64');
        value |= BigInt(byte & 127) << BigInt(i * 7);
        if (!(byte & 128)) {
          if (i > 0 && byte === 0) fail('Noncanonical protobuf varint');
          return value;
        }
      }
      return fail('Protobuf varint exceeds uint64');
    }
    while (at < end) {
      const tag = varint();
      if (tag > 0xffffffffn) fail('Invalid protobuf tag');
      const field = Number(tag >> 3n),
        wire = Number(tag & 7n);
      if (field === 0) fail('Invalid protobuf field number');
      if (wire === 4) {
        if (group !== field) fail('Unexpected protobuf end-group');
        return { next: at };
      }
      const known = (kind === 'response' && field === 2) || (kind === 'result' && field === 3);
      if (known && (wire !== 2 || found)) fail('Invalid or duplicate long-message response field');
      if (known) found = true;
      if (wire === 0) varint();
      else if (wire === 1 || wire === 5) {
        at += wire === 1 ? 8 : 4;
        if (at > end) fail('Truncated protobuf fixed field');
      } else if (wire === 2) {
        const count = varint();
        if (count > BigInt(end - at)) fail('Truncated protobuf length field');
        const stop = at + Number(count);
        if (known && kind === 'response') resId = scan(at, stop, 'result', depth + 1).resId;
        else if (known) {
          if (count === 0n || count > BigInt(MAX_RES_ID))
            fail('Invalid long-message resource ID length');
          try {
            resId = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
              bytes.subarray(at, stop),
            );
          } catch {
            fail('Invalid long-message resource ID UTF-8');
          }
        }
        at = stop;
      } else if (wire === 3) at = scan(at, end, 'unknown', depth + 1, field).next;
      else fail('Invalid protobuf wire type');
    }
    if (group !== undefined) fail('Unterminated protobuf group');
    if (kind !== 'unknown' && (!found || resId === undefined))
      fail('Missing long-message resource ID');
    return { next: at, resId };
  }
  return { resId: scan(0, bytes.length, 'response', 0).resId! };
}
export interface LongMessageResponseService {
  sendSsoCmdReqByContend(command: string, data: Buffer): unknown;
}
export interface LongMessageTransportOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
/** Internal only: one native dispatch, no retries, no upload/account acceptance claim. */
export function createLongMessageResponseTransport(service: LongMessageResponseService) {
  if (!service || typeof service.sendSsoCmdReqByContend !== 'function')
    throw new LongMessageResponseError('input', 'Missing native long-message transport');
  let closed = false;
  const outstanding = new Set<() => void>();
  return {
    send(
      command: string,
      input: Buffer,
      options: LongMessageTransportOptions = {},
    ): Promise<{ resId: string }> {
      if (
        command !== LONG_MESSAGE_COMMAND ||
        !regularBuffer(input) ||
        input.length === 0 ||
        input.length > MAX_WIRE
      )
        return Promise.reject(
          new LongMessageResponseError('input', 'Invalid long-message command or request buffer'),
        );
      if (
        !options ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        (options.signal !== undefined && !(options.signal instanceof AbortSignal))
      )
        return Promise.reject(
          new LongMessageResponseError('input', 'Invalid long-message transport options'),
        );
      const timeout = options.timeoutMs ?? 5000;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000)
        return Promise.reject(
          new LongMessageResponseError('input', 'Invalid long-message timeout'),
        );
      const request = Buffer.from(input),
        signal = options.signal;
      if (closed || signal?.aborted)
        return Promise.reject(
          new LongMessageResponseError('lifecycle', 'Long-message transport is closed or canceled'),
        );
      return new Promise((resolve, reject) => {
        let settled = false,
          dispatched = false;
        const timer: { handle?: ReturnType<typeof setTimeout> } = {};
        const finish = (error: unknown, value?: { resId: string }) => {
          if (settled) return;
          settled = true;
          if (timer.handle !== undefined) clearTimeout(timer.handle);
          signal?.removeEventListener('abort', cancel);
          outstanding.delete(cancel);
          if (error) reject(error);
          else resolve(value!);
        };
        const cancel = () =>
          finish(
            new LongMessageResponseError(
              'lifecycle',
              'Long-message request canceled or transport closed',
              dispatched,
            ),
          );
        outstanding.add(cancel);
        signal?.addEventListener('abort', cancel, { once: true });
        if (closed || signal?.aborted) {
          cancel();
          return;
        }
        timer.handle = setTimeout(
          () =>
            finish(
              new LongMessageResponseError(
                'lifecycle',
                'Long-message response timed out',
                dispatched,
              ),
            ),
          timeout,
        );
        dispatched = true;
        let returned: unknown;
        try {
          returned = service.sendSsoCmdReqByContend(command, request);
        } catch {
          finish(
            new LongMessageResponseError('native', 'Native long-message dispatch failed', true),
          );
          return;
        }
        Promise.resolve(returned)
          .then(
            (value) => {
              if (settled) return;
              if (closed || signal?.aborted) {
                cancel();
                return;
              }
              const object = value as Record<string, unknown> | null;
              const descriptor =
                object &&
                typeof object === 'object' &&
                (Object.getPrototypeOf(object) === Object.prototype ||
                  Object.getPrototypeOf(object) === null)
                  ? Object.getOwnPropertyDescriptor(object, 'rspbuffer')
                  : undefined;
              if (
                !descriptor ||
                !('value' in descriptor) ||
                !regularBuffer(descriptor.value) ||
                descriptor.value.length === 0 ||
                descriptor.value.length > MAX_WIRE
              ) {
                finish(
                  new LongMessageResponseError(
                    'response',
                    'Native long-message response has no valid rspbuffer',
                    true,
                    'response-received',
                  ),
                );
                return;
              }
              try {
                finish(undefined, parseLongMessageResponse(Buffer.from(descriptor.value)));
              } catch (error) {
                finish(
                  new LongMessageResponseError(
                    'protobuf',
                    error instanceof LongMessageResponseError
                      ? error.message
                      : 'Invalid long-message protobuf response',
                    true,
                    'response-received',
                  ),
                );
              }
            },
            () =>
              finish(
                new LongMessageResponseError(
                  'native',
                  'Native long-message response rejected',
                  true,
                ),
              ),
          )
          .catch(() =>
            finish(
              new LongMessageResponseError(
                'response',
                'Native long-message response inspection failed',
                true,
                'response-received',
              ),
            ),
          );
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const cancel of [...outstanding]) cancel();
    },
  };
}
