import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupRequests } from '../src/group-requests.ts';
const notify = (type: number, seq = '123', status = 1) => ({ seq, type, status, group: { groupCode: '456', groupName: 'name' }, postscript: 'message' });
function fixture() {
  let listener: any;
  let result: unknown = { result: 0 };
  const calls: unknown[][] = [];
  const events: { event: string; payload: any }[] = [];
  const service = {
    addKernelGroupListener: (value: unknown) => { listener = value; return 9; },
    removeKernelGroupListener: (id: number) => { calls.push(['remove', id]); },
    getSingleScreenNotifies: (...args: unknown[]) => { calls.push(['get', ...args]); return result; },
    operateSysNotify: (...args: unknown[]): unknown => { calls.push(['operate', ...args]); },
  };
  const module = createGroupRequests({ getGroupService: () => service }, (event, payload) => events.push({ event, payload }));
  return { module, calls, events, service, result: (value: unknown) => { result = value; }, page: (doubt: boolean, next: string, values: unknown[]) => listener.onGroupSingleScreenNotifies(doubt, next, values), update: (doubt: boolean, values: unknown[]) => listener.onGroupNotifiesUpdated(doubt, values) };
}

test('group request pages await matching native events and preserve next cursor', async () => {
  const f = fixture(); let resolved = false;
  const pending = f.module.invokeOperation('listGroupRequests', { options: { doubt: true, before: '10', limit: 3 } }).then(value => { resolved = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, [['get', true, '10', 3]]);
  f.page(false, '12', [notify(7)]); await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false);
  f.page(true, '20', [notify(1), notify(5, '124'), notify(7, '125'), notify(8, '126')]);
  const page = await pending;
  assert.ok(page); assert.equal(page.next, '20');
  assert.deepEqual(page.requests.map(request => request.kind), ['invite', 'invite-approval', 'join']);
  assert.ok(page.requests.every(request => request.doubt));
  f.module.close(); assert.deepEqual(f.calls.at(-1), ['remove', 9]);
});

test('only unhandled actionable types emit, with per-request deduplication', () => {
  const f = fixture();
  f.update(false, [notify(1), notify(5, '124'), notify(7, '125'), notify(7, '126', 2), notify(8, '127')]);
  f.update(false, [notify(1)]);
  assert.equal(f.events.length, 3); assert.ok(f.events.every(event => event.event === 'request.group'));
  assert.equal(f.calls.length, 0, 'notifications never automatically approve');
  f.module.close(); f.update(true, [notify(1)]); assert.equal(f.events.length, 3);
});

test('explicit accept and reject preserve native request type/doubt and reason defaults', async () => {
  const f = fixture();
  await f.module.invokeOperation('handleGroupRequest', { request: { groupId: '456', sequence: '123', type: 1, doubt: false }, accept: true });
  await f.module.invokeOperation('handleGroupRequest', { request: { groupId: '456', sequence: '124', type: 7, doubt: true }, accept: false, reason: 'reason' });
  assert.deepEqual(f.calls, [
    ['operate', false, { operateType: 1, targetMsg: { seq: '123', type: 1, groupCode: '456', postscript: ' ' } }],
    ['operate', true, { operateType: 2, targetMsg: { seq: '124', type: 7, groupCode: '456', postscript: 'reason' } }],
  ]);
  const valid = { groupId: '456', sequence: '123', type: 1, doubt: false };
  for (const payload of [{ request: { ...valid, type: 8 }, accept: true }, { request: valid, accept: 'true' }, { request: { ...valid, sequence: 'bad' }, accept: false }, { request: valid, accept: true, reason: 1 }]) await assert.rejects(f.module.invokeOperation('handleGroupRequest', payload));
  assert.equal(f.calls.length, 2);
  f.service.operateSysNotify = () => ({ result: 5 });
  await assert.rejects(f.module.invokeOperation('handleGroupRequest', { request: valid, accept: true }), /failed/);
  f.module.close();
});

test('list failures and closure reject; concurrent cursors serialize native requests', async () => {
  const f = fixture();
  const first = f.module.invokeOperation('listGroupRequests');
  const second = f.module.invokeOperation('listGroupRequests', { options: { before: '123' } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 1);
  f.page(false, '123', []); await first;
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(f.calls[1], ['get', false, '123', 20]);
  f.page(false, '', []); await second;
  f.result({ result: 5 }); await assert.rejects(f.module.invokeOperation('listGroupRequests'), /failed/);
  f.module.close();
  const closing = fixture(); const pending = closing.module.invokeOperation('listGroupRequests');
  await new Promise(resolve => setImmediate(resolve)); closing.module.close(); await assert.rejects(pending, /closed/);
  await assert.rejects(f.module.invokeOperation('listGroupRequests'), /closed/);
});


test('timed-out pages invalidate queries; late callbacks cannot satisfy a later cursor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const pending = f.module.invokeOperation('listGroupRequests');
  const rejected = assert.rejects(pending, /timed out.*recreate the Session/);
  await new Promise(resolve => setImmediate(resolve));
  // A malformed unsolicited update does not reject or complete the list query.
  f.update(false, [{ ...notify(1), status: 'invalid' }]);
  t.mock.timers.tick(10001);
  await rejected;
  f.page(false, '200', [notify(1)]);
  await assert.rejects(f.module.invokeOperation('listGroupRequests', { options: { before: '200' } }), /query channel is invalid/);
  assert.deepEqual(f.calls, [['get', false, '', 20]], 'no later native query is dispatched');
  f.module.close();
});
