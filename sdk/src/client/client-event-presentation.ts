import type { NativeCallbackAudit } from '../contracts/native.ts';
import type { MessageEvent } from '../contracts/messages.ts';
import type { FriendRequestEvent } from '../contracts/contacts.ts';
import type { GroupRequestEvent } from '../contracts/groups.ts';

/** A property view for the existing worker event presentation. These fields are
 * checked where interpreted; the original opaque payload is still forwarded.
 * This is not validation of a native event or a business result.
 */
interface EventFields {
  family?: unknown;
  name?: unknown;
  argumentTypes?: unknown;
  message?: unknown;
  image?: unknown;
}

interface EventPresenters {
  message(value: unknown): MessageEvent | undefined;
  friendRequest(value: unknown): FriendRequestEvent | undefined;
  groupRequest(value: unknown): GroupRequestEvent | undefined;
}

/** Present worker events and retain a bounded shape-only callback audit for one
 * public client, across worker generations. Lifecycle owns generation filtering.
 * Delivery is synchronous: observer failures propagate and prevent later aliases.
 */
export function createClientEventPresentation(
  emit: (event: string, payload: unknown) => unknown,
  presenters: EventPresenters,
) {
  const audit = new Map<string, NativeCallbackAudit>();
  return {
    forward(event: string, value: unknown): void {
      const fields = value as EventFields | null | undefined;
      // Aliases are produced here from a validated message, never trusted as
      // worker input; otherwise they could bypass immutable peer capture.
      if (event === 'message.private' || event === 'message.group') {
        emit('diagnostic', { stage: 'invalid-worker-message-alias' });
        return;
      }
      if (event === 'message') {
        const message = presenters.message(value);
        if (!message) {
          emit('diagnostic', { stage: 'invalid-worker-message-peer' });
          return;
        }
        // The presenter captures an immutable peer before exposing the event.
        // Both deliveries and reply therefore retain the same conversation.
        const alias = message.peer.type === 'group' ? 'message.group' : 'message.private';
        emit('message', message);
        emit(alias, message);
        return;
      }
      if (event === 'request.friend' || event === 'friend-request' || event === 'request.group') {
        const friend = event !== 'request.group';
        const request = friend ? presenters.friendRequest(value) : presenters.groupRequest(value);
        if (!request) {
          emit('diagnostic', {
            stage: friend ? 'invalid-worker-friend-request' : 'invalid-worker-group-request',
          });
          return;
        }
        emit(friend ? 'request.friend' : 'request.group', request);
        if (friend) emit('friend-request', request);
        return;
      }
      if (event === 'native-callback') {
        const { family, name, argumentTypes } = fields ?? {};
        if (
          typeof family === 'string' &&
          typeof name === 'string' &&
          Array.isArray(argumentTypes) &&
          argumentTypes.every((value) => typeof value === 'string')
        ) {
          const key = JSON.stringify([family, name, argumentTypes]);
          const existing = audit.get(key);
          if (existing) existing.count++;
          else if (audit.size < 128)
            audit.set(key, { family, name, argumentTypes: [...argumentTypes], count: 1 });
        }
      }
      const payload =
        event === 'login-error'
          ? new Error(typeof fields?.message === 'string' ? fields.message : 'Native login failed')
          : value;
      if (event === 'qrcode' && fields && typeof fields.image === 'string')
        fields.image = Buffer.from(fields.image, 'base64');
      emit(event, payload);
    },
    /** Independent snapshots contain shapes and counts, never callback arguments. */
    get audit(): NativeCallbackAudit[] {
      return [...audit.values()].map((value) => ({
        ...value,
        argumentTypes: [...value.argumentTypes],
      }));
    },
  };
}
