import {
  createPacketTransport,
  PacketTransportError,
  type PacketService,
} from '../../runtime/packet-transport.ts';
import {
  buildForwardResourceRequest,
  parseForwardResourceResponse,
} from './forward-resource-wire.ts';
import { normalizeForwardResourceId } from './forward-resource-input.ts';
import type { ForwardResource } from '../../contracts/forward.ts';

export type ForwardResourceFailureStage =
  'input' | 'lifecycle' | 'native' | 'response' | 'protobuf';
export class ForwardResourceError extends Error {
  readonly stage: ForwardResourceFailureStage;
  readonly dispatched: boolean;
  constructor(stage: ForwardResourceFailureStage, message: string, dispatched = false) {
    super(message);
    this.name = 'ForwardResourceError';
    this.stage = stage;
    this.dispatched = dispatched;
  }
}
export type ForwardResourceService = PacketService;
export interface ForwardResourceReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
const MAX_RESPONSE = 8 * 1024 * 1024;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const isAborted = (signal?: AbortSignal): boolean =>
  signal === undefined ? false : aborted.call(signal);
function captureOptions(value: unknown): ForwardResourceReadOptions {
  if (
    !value ||
    typeof value !== 'object' ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  )
    throw Error();
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
      if (
        !Number.isSafeInteger(descriptor.value) ||
        descriptor.value < 1 ||
        descriptor.value > 60000
      )
        throw Error();
      captured.timeoutMs = descriptor.value;
    }
  }
  return captured;
}
function packetFailure(
  error: PacketTransportError,
  dispatched = error.dispatched,
): ForwardResourceError {
  switch (error.kind) {
    case 'canceled':
      return new ForwardResourceError(
        'lifecycle',
        'Forward-resource request canceled or transport closed',
        dispatched,
      );
    case 'timeout':
      return new ForwardResourceError(
        'lifecycle',
        'Forward-resource response timed out',
        dispatched,
      );
    case 'missing':
      return new ForwardResourceError('input', 'Missing forward-resource transport', dispatched);
    case 'envelope':
      return new ForwardResourceError(
        'response',
        'Invalid forward-resource response envelope',
        dispatched,
      );
    case 'inspection':
      return new ForwardResourceError(
        'response',
        'Forward-resource response inspection failed',
        dispatched,
      );
    case 'rejected':
      return new ForwardResourceError(
        'native',
        'Native forward-resource response rejected',
        dispatched,
      );
    default:
      return new ForwardResourceError(
        'native',
        'Native forward-resource dispatch failed',
        dispatched,
      );
  }
}

/** Protocol input and resource-ID validation remain domain owned. The byte
 * transport performs one native dispatch and observes completion after cancel.
 */
export function createForwardResourceTransport(service: ForwardResourceService) {
  const packets = createPacketTransport(service);
  return {
    read(
      selfUid: string,
      resourceId: string,
      options: ForwardResourceReadOptions = {},
    ): Promise<ForwardResource> {
      let captured: ForwardResourceReadOptions,
        expectedResourceId: string,
        built: ReturnType<typeof buildForwardResourceRequest>;
      try {
        captured = captureOptions(options);
        expectedResourceId = normalizeForwardResourceId(resourceId);
        built = buildForwardResourceRequest(selfUid, expectedResourceId);
      } catch {
        return Promise.reject(
          new ForwardResourceError('input', 'Invalid forward-resource request'),
        );
      }
      const signal = captured.signal;
      try {
        packets.assertOpen(signal);
      } catch {
        return Promise.reject(
          new ForwardResourceError('lifecycle', 'Forward-resource transport is closed or canceled'),
        );
      }
      return packets
        .request(built.command, built.data, {
          signal,
          timeoutMs: captured.timeoutMs ?? 5000,
          maxResponseBytes: MAX_RESPONSE,
        })
        .then((bytes) => {
          try {
            packets.assertOpen(signal);
            const resource = parseForwardResourceResponse(bytes, expectedResourceId);
            packets.assertOpen(signal);
            return resource;
          } catch (error) {
            if (error instanceof PacketTransportError) throw packetFailure(error, true);
            throw new ForwardResourceError(
              'protobuf',
              'Invalid forward-resource protobuf response',
              true,
            );
          }
        })
        .catch((error: unknown) => {
          if (error instanceof PacketTransportError) throw packetFailure(error);
          throw error;
        });
    },
    close: () => packets.close(),
  };
}
