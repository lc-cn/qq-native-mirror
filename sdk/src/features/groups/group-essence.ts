import { nativeResultError } from '../../errors.ts';
import { captureGroupEssenceRequest } from './group-essence-input.ts';

export interface GroupEssenceContext {
  signal: AbortSignal;
  query(groupId: string, messageId: string): Promise<unknown>;
  invoke(
    method: 'addGroupEssence' | 'removeGroupEssence',
    request: {
      groupCode: string;
      msgRandom: number;
      msgSeq: number;
    },
  ): unknown;
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}

/** Essence has two status layers rather than GeneralCallResult.result.
 * Only explicit numeric zero statuses acknowledge completion. Do not expose
 * native wording, message data or opaque response objects through error IPC.
 * The acknowledgement does not replace separately authorized server readback.
 */
function acknowledge(value: unknown): void {
  const outer = field(value, 'errCode');
  if (
    typeof outer !== 'number' ||
    !Number.isInteger(outer) ||
    outer < -0x8000_0000 ||
    outer > 0x7fff_ffff
  )
    throw nativeResultError('Invalid native group essence result', undefined);
  if (outer !== 0)
    throw nativeResultError('Native group essence invocation failed', { result: outer });
  const inner = field(field(value, 'result'), 'errorCode');
  if (typeof inner !== 'number' || !Number.isInteger(inner) || inner < 0 || inner > 0xffff_ffff)
    throw nativeResultError('Invalid native group essence response', undefined);
  if (inner !== 0)
    throw nativeResultError('Native group essence response failed', { result: inner });
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function sequence(value: unknown, name: string): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new Error(`Invalid native essence ${name}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 0xffff_ffff)
    throw new Error(`Invalid native essence ${name}`);
  return number;
}

/** Resolve the exact group message before a single, non-replayed mutation.
 * The pinned upstream group API derives wire sequence/random from message data;
 * neither value may be substituted by the public message ID.
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L379-L436
 * Parameter and response codecs are separately checked in the actual binaries;
 * upstream OneBot fulfillment alone does not validate either result status.
 */
export async function setGroupEssenceMessage(
  context: GroupEssenceContext,
  groupId: unknown,
  messageId: unknown,
  enabled: unknown,
): Promise<void> {
  const captured = captureGroupEssenceRequest(groupId, messageId, enabled);
  context.signal.throwIfAborted();
  const message = await context.awaitAlive(context.query(captured.groupId, captured.messageId));
  context.signal.throwIfAborted();
  if (
    field(message, 'msgId') !== captured.messageId ||
    field(message, 'chatType') !== 2 ||
    field(message, 'peerUid') !== captured.groupId
  )
    throw new Error('Native essence lookup did not return the requested group message');
  const request = {
    groupCode: captured.groupId,
    msgRandom: sequence(field(message, 'msgRandom'), 'random'),
    msgSeq: sequence(field(message, 'msgSeq'), 'sequence'),
  };
  context.signal.throwIfAborted();
  const result = await context.awaitAlive(
    context.invoke(captured.enabled ? 'addGroupEssence' : 'removeGroupEssence', request),
  );
  context.signal.throwIfAborted();
  acknowledge(result);
  context.signal.throwIfAborted();
}
