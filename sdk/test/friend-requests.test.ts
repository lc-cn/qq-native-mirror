import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFriendRequests } from '../src/friend-requests.ts';
const incoming = { friendUid: 'u_request', reqTime: '123', friendNick: 'nick', extWords: 'hello', isDecide: false, isUnread: true };
test('friend metadata shares the Buddy listener without completing or invalidating request queries', async () => {
  let listener: any, registrations = 0, queries = 0;
  const removed: number[] = [], events: [string, any][] = [];
  const operations = createFriendRequests({ getBuddyService: () => ({
    addKernelBuddyListener(value: any) { registrations++; listener = value; return 7; },
    removeKernelBuddyListener(id: number) { removed.push(id); },
    getBuddyReq() { queries++; return { result: 0 }; },
  }) }, (name, value) => events.push([name, value]));
  try {
    let resolved = false;
    const query = operations.invokeOperation('listFriendRequests').then(value => { resolved = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    listener.onBuddyListChange([{ categoryId: 0, categoryName: '', categoryMbCount: 0, buddyList: [] }]);
    listener.onBuddyListChange([{ categoryId: 0, buddyList: [] }]);
    listener.onBuddyListChangedV2({ credential: 'fixture-secret' });
    listener.onBuddyInfoChange({ credential: 'fixture-secret' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resolved, false);
    listener.onBuddyReqChange({ buddyReqs: [incoming] });
    assert.equal((await query as any[]).length, 1);
    assert.deepEqual(events.map(([name]) => name), ['friend-list-updated', 'diagnostic', 'friend-request']);
    assert.equal(registrations, 1); assert.equal(queries, 1);
    operations.close();
    listener.onBuddyListChange([]); listener.onBuddyReqChange({ buddyReqs: [{ ...incoming, reqTime: '124' }] });
    assert.equal(events.length, 3); assert.deepEqual(removed, [7]);
    assert.doesNotMatch(JSON.stringify(events), /credential|fixture-secret/);
  } finally { operations.close(); }
});
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

test('timed-out friend queries reject later lists before dispatch; unsolicited events still arrive', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    const pending = f.operations.invokeOperation('listFriendRequests');
    const rejected = assert.rejects(pending, /timed out/);
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(10_001);
    await rejected;
    const nextRejected = assert.rejects(f.operations.invokeOperation('listFriendRequests'), /query channel is invalid.*recreate the Session/);
    await new Promise(resolve => setImmediate(resolve));
    // This can be the first query's late callback; it cannot identify a new query.
    f.notify([incoming]);
    await nextRejected;
    assert.deepEqual(f.calls, [['get']], 'no uncorrelatable later query is dispatched');
    assert.equal(f.emitted.length, 1, 'unsolicited requests remain observable');
  } finally { f.operations.close(); }
});

test('native friend query failure overrides early notification and invalidates only listing', async () => {
  const f = fixture();
  try {
    f.service.getBuddyReq = () => { f.calls.push(['get']); f.notify([incoming]); return { result: 73 }; };
    await assert.rejects(f.operations.invokeOperation('listFriendRequests'), error => (error as any).code === 73);
    await assert.rejects(f.operations.invokeOperation('listFriendRequests'), /query channel is invalid/);
    await f.operations.invokeOperation('handleFriendRequest', { request: { uid: 'u_request', time: '123' }, accept: false });
    assert.deepEqual(f.calls, [['get'], ['approve', { friendUid: 'u_request', reqTime: '123', accept: false }]]);
  } finally { f.operations.close(); }
});
