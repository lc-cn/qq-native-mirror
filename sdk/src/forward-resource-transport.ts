import { buildForwardResourceRequest, parseForwardResourceResponse, normalizeForwardResourceId } from './forward-resource-wire.ts';
import type { ForwardResource } from './types.ts';

export type ForwardResourceFailureStage = 'input' | 'lifecycle' | 'native' | 'response' | 'protobuf';
export class ForwardResourceError extends Error {
  readonly stage: ForwardResourceFailureStage;
  readonly dispatched: boolean;
  constructor(stage: ForwardResourceFailureStage, message: string, dispatched = false) {
    super(message); this.name = 'ForwardResourceError'; this.stage = stage; this.dispatched = dispatched;
  }
}
export interface ForwardResourceService { sendSsoCmdReqByContend(command: string, data: Buffer): unknown }
export interface ForwardResourceReadOptions { signal?: AbortSignal; timeoutMs?: number }
const MAX_RESPONSE = 8 * 1024 * 1024;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const isAborted = (signal?: AbortSignal): boolean => signal === undefined ? false : aborted.call(signal);
const regularBuffer = (value: unknown): value is Buffer => Buffer.isBuffer(value) && Object.getPrototypeOf(value) === Buffer.prototype;
function captureOptions(value: unknown): ForwardResourceReadOptions {
  if (!value || typeof value !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw Error();
  const captured: ForwardResourceReadOptions = {};
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'signal' && key !== 'timeoutMs') throw Error();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw Error();
    if (key === 'signal') {
      if (!(descriptor.value instanceof AbortSignal)) throw Error();
      isAborted(descriptor.value); // Validate native signal brand without user-defined getters.
      captured.signal = descriptor.value;
    } else {
      if (!Number.isSafeInteger(descriptor.value) || descriptor.value < 1 || descriptor.value > 60000) throw Error();
      captured.timeoutMs = descriptor.value;
    }
  }
  return captured;
}
/** Internal read-only single-dispatch adapter. Cancellation retires observation,
 * not the native operation; late native results/rejections remain observed. */
export function createForwardResourceTransport(service: ForwardResourceService) {
  let closed = false;
  const outstanding = new Set<() => void>();
  return {
    read(selfUid: string, resourceId: string, options: ForwardResourceReadOptions = {}): Promise<ForwardResource> {
      let command: string, request: Buffer, expectedResourceId: string, signal: AbortSignal | undefined, timeout: number;
      try {
        const captured = captureOptions(options);
        signal = captured.signal; timeout = captured.timeoutMs ?? 5000;
        expectedResourceId = normalizeForwardResourceId(resourceId);
        const built = buildForwardResourceRequest(selfUid, expectedResourceId);
        command = built.command; request = Buffer.from(built.data);
      } catch { return Promise.reject(new ForwardResourceError('input', 'Invalid forward-resource request')); }
      if (closed || isAborted(signal)) return Promise.reject(new ForwardResourceError('lifecycle', 'Forward-resource transport is closed or canceled'));
      return new Promise((resolve, reject) => {
        let settled = false, dispatched = false, timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: ForwardResourceError, result?: ForwardResource) => {
          if (settled) return;
          settled = true; if (timer !== undefined) clearTimeout(timer);
          if (signal) EventTarget.prototype.removeEventListener.call(signal, 'abort', cancel); outstanding.delete(cancel);
          if (error) reject(error); else resolve(result!);
        };
        const cancel = () => finish(new ForwardResourceError('lifecycle', 'Forward-resource request canceled or transport closed', dispatched));
        outstanding.add(cancel); if (signal) EventTarget.prototype.addEventListener.call(signal, 'abort', cancel, { once: true });
        if (closed || isAborted(signal)) { cancel(); return; }
        timer = setTimeout(() => finish(new ForwardResourceError('lifecycle', 'Forward-resource response timed out', dispatched)), timeout);
        let returned: unknown;
        try {
          // Inspect this property only at dispatch; never access arbitrary native error fields.
          const method = service?.sendSsoCmdReqByContend;
          if (typeof method !== 'function') { finish(new ForwardResourceError('input', 'Missing forward-resource transport')); return; }
          if (closed || isAborted(signal)) { cancel(); return; }
          dispatched = true; returned = method.call(service, command, request);
        } catch { finish(new ForwardResourceError('native', 'Native forward-resource dispatch failed', dispatched)); return; }
        Promise.resolve(returned).then(value => {
          if (settled) return;
          if (closed || isAborted(signal)) { cancel(); return; }
          const object = value && typeof value === 'object' && [null, Object.prototype].includes(Object.getPrototypeOf(value)) ? value : undefined;
          const descriptor = object ? Object.getOwnPropertyDescriptor(object, 'rspbuffer') : undefined;
          if (!descriptor || !('value' in descriptor) || !regularBuffer(descriptor.value) || descriptor.value.length === 0 || descriptor.value.length > MAX_RESPONSE) {
            finish(new ForwardResourceError('response', 'Invalid forward-resource response envelope', true)); return;
          }
          const response = Buffer.from(descriptor.value);
          try { finish(undefined, parseForwardResourceResponse(response, expectedResourceId)); }
          catch { finish(new ForwardResourceError('protobuf', 'Invalid forward-resource protobuf response', true)); }
        }, () => finish(new ForwardResourceError('native', 'Native forward-resource response rejected', true)))
          .catch(() => finish(new ForwardResourceError('response', 'Forward-resource response inspection failed', true)));
      });
    },
    close() { if (closed) return; closed = true; for (const cancel of [...outstanding]) cancel(); },
  };
}
