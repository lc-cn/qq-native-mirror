import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFriendRequests } from '../src/friend-requests.ts';
const incoming = { friendUid: 'u_request', reqTime: '123', friendNick: 'nick', extWords: 'hello', isDecide: false, isUnread: true };
function fixture() {
  let listener: any;
  const emitted: { event: string; payload: any }[] = [];
  const calls: any[] = [];
  let result: unknown = { result: 0 };
  const service = {
    addKernelBuddyListener: (value: any) => { listener = value; return 7; },
    removeKernelBuddyListener: (id: number) => { calls.push(['remove', id]); },
    getBuddyReq: () => { calls.push(['get']); return result; },
    approvalFriendRequest: (value: unknown) => { calls.push(['approve', value]); return undefined; },
  };
  const operations = createFriendRequests({ getBuddyService: () => service }, (event, payload) => emitted.push({ event, payload }));
  return { operations, emitted, calls, service, notify: (requests: unknown[]) => listener.onBuddyReqChange({ unreadNums: 1, buddyReqs: requests }), result: (value: unknown) => { result = value; } };
}

test('lists wait for actual native notification and coalesce concurrent callers', async () => {
  const f = fixture();
  let resolved = false;
  const first = f.operations.invokeOperation('listFriendRequests').then(value => { resolved = true; return value; });
  const second = f.operations.invokeOperation('listFriendRequests');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false, 'native call success alone is insufficient');
  assert.deepEqual(f.calls, [['get']]);
  f.notify([incoming]);
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [{ uid: 'u_request', time: '123', nickname: 'nick', message: 'hello', decided: false, unread: true, initiator: false, raw: incoming }]);
  f.operations.close();
  assert.deepEqual(f.calls.at(-1), ['remove', 7]);
});

test('only undecided incoming notifications emit, deduplicated by UID and time', () => {
  const f = fixture();
  f.notify([incoming, { ...incoming, friendUid: 'u_decided', isDecide: true }, { ...incoming, friendUid: 'u_outgoing', isInitiator: true }]);
  f.notify([incoming]);
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0].event, 'friend-request');
  assert.ok(!f.calls.some(call => call[0] === 'approve'), 'never auto-approves');
  f.operations.close();
  f.notify([{ ...incoming, reqTime: '124' }]);
  assert.equal(f.emitted.length, 1);
});

test('explicit approval/rejection validates native payload and handles void dispatch', async () => {
  const f = fixture();
  await f.operations.invokeOperation('handleFriendRequest', { request: { uid: 'u_request', time: '123' }, accept: false });
  assert.deepEqual(f.calls, [['approve', { friendUid: 'u_request', reqTime: '123', accept: false }]]);
  for (const payload of [{}, { request: { uid: '', time: '123' }, accept: true }, { request: { uid: 'u', time: 'bad' }, accept: false }, { request: { uid: 'u', time: '123' }, accept: 1 }]) {
    await assert.rejects(f.operations.invokeOperation('handleFriendRequest', payload));
  }
  assert.equal(f.calls.length, 1);
  f.service.approvalFriendRequest = () => ({ result: 5 }) as any;
  await assert.rejects(f.operations.invokeOperation('handleFriendRequest', { request: { uid: 'u', time: '123' }, accept: true }), /failed/);
  f.operations.close();
});

test('list errors, invalid notifications and shutdown reject rather than fabricate empty lists', async () => {
  const failed = fixture(); failed.result({ result: 5 });
  await assert.rejects(failed.operations.invokeOperation('listFriendRequests'), /failed/); failed.operations.close();
  const invalid = fixture(); const invalidList = invalid.operations.invokeOperation('listFriendRequests');
  invalid.notify([{ ...incoming, isDecide: 'false' }]);
  await assert.rejects(invalidList, /flags/); invalid.operations.close();
  const closing = fixture(); const pending = closing.operations.invokeOperation('listFriendRequests');
  closing.operations.close(); await assert.rejects(pending, /closed/);
  await assert.rejects(closing.operations.invokeOperation('listFriendRequests'), /closed/);
});
