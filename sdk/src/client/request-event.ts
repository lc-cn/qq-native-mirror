import type { FriendRequest, FriendRequestEvent } from '../contracts/contacts.ts';
import type { GroupRequest, GroupRequestEvent } from '../contracts/groups.ts';
import { captureFriendRequest } from '../features/contacts/friend-request-input.ts';
import { captureGroupRequestOperation } from '../features/groups/group-request-input.ts';

export interface FriendRequestEventContext {
  assertActive(): void;
  handleFriendRequest(request: Pick<FriendRequest, 'uid' | 'time'>, accept: boolean): Promise<void>;
}

export interface GroupRequestEventContext {
  assertActive(): void;
  handleGroupRequest(
    request: Pick<GroupRequest, 'groupId' | 'sequence' | 'type' | 'doubt'>,
    accept: boolean,
    reason?: string,
  ): Promise<void>;
}

function snapshot(value: unknown): PropertyDescriptorMap | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  return Object.getOwnPropertyDescriptors(value);
}

function dataField(descriptors: PropertyDescriptorMap, key: string): unknown {
  const descriptor = Object.hasOwn(descriptors, key) ? descriptors[key] : undefined;
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Bind one request's approval identity before observers receive its public view.
 * Only the selected identity is validated; native display fields and raw data
 * retain their original descriptors and references. Invalid identities are not
 * actionable events, and the presentation owner decides how to diagnose them.
 */
export function createFriendRequestEvent(
  value: unknown,
  context: FriendRequestEventContext,
): FriendRequestEvent | undefined {
  let descriptors: PropertyDescriptorMap;
  let request: Pick<FriendRequest, 'uid' | 'time'>;
  try {
    const captured = snapshot(value);
    if (!captured) return;
    descriptors = captured;
    request = captureFriendRequest({
      request: { uid: dataField(captured, 'uid'), time: dataField(captured, 'time') },
      accept: true,
    }).request;
  } catch {
    // Descriptor traps and malformed identity details stay outside diagnostics.
    return;
  }
  delete descriptors.approve;
  const event = Object.defineProperties({}, descriptors) as FriendRequestEvent;
  Object.defineProperty(event, 'approve', {
    enumerable: false,
    value: async (accept = true): Promise<void> => {
      context.assertActive();
      const captured = captureFriendRequest({ request, accept });
      context.assertActive();
      return context.handleFriendRequest(captured.request, captured.accept);
    },
  });
  return event;
}

/** Group decisions keep the exact sequence, request type and doubt branch. A
 * successful submission follows the existing action's acknowledgement semantics;
 * this helper neither retries nor confirms the remote membership change.
 */
export function createGroupRequestEvent(
  value: unknown,
  context: GroupRequestEventContext,
): GroupRequestEvent | undefined {
  let descriptors: PropertyDescriptorMap;
  let request: Pick<GroupRequest, 'groupId' | 'sequence' | 'type' | 'doubt'>;
  try {
    const captured = snapshot(value);
    if (!captured) return;
    descriptors = captured;
    request = captureGroupRequestOperation('handleGroupRequest', {
      request: {
        groupId: dataField(captured, 'groupId'),
        sequence: dataField(captured, 'sequence'),
        type: dataField(captured, 'type'),
        doubt: dataField(captured, 'doubt'),
      },
      accept: true,
    }).payload.request;
  } catch {
    return;
  }
  delete descriptors.approve;
  const event = Object.defineProperties({}, descriptors) as GroupRequestEvent;
  Object.defineProperty(event, 'approve', {
    enumerable: false,
    value: async (accept = true, reason?: string): Promise<void> => {
      context.assertActive();
      const captured = captureGroupRequestOperation('handleGroupRequest', {
        request,
        accept,
        reason,
      }).payload;
      context.assertActive();
      return context.handleGroupRequest(captured.request, captured.accept, captured.reason);
    },
  });
  return event;
}
