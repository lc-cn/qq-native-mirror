import { normalizeMessageQuery } from './query-input.ts';

function plain(value: unknown): object {
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error('Recall input requires a plain object');
  return value;
}
function field(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor))
    throw new Error('Recall input requires own data properties');
  return descriptor.value;
}
export function captureRecallRequest(peer: unknown, messageId: unknown) {
  const object = plain(peer);
  const type = field(object, 'type');
  const captured =
    type === 'private'
      ? { type, userId: field(object, 'userId') }
      : type === 'group'
        ? { type, groupId: field(object, 'groupId') }
        : { type };
  return normalizeMessageQuery(captured, messageId);
}
export function captureRecallPayload(payload: unknown) {
  const object = plain(payload);
  return captureRecallRequest(field(object, 'peer'), field(object, 'messageId'));
}
