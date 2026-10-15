import assert from 'node:assert/strict';
import test from 'node:test';
import type { GroupRequest, GroupRequestParticipant } from '../../../src/index.ts';
import {
  createGroupRequests,
  type GroupRequestListener,
} from '../../../src/features/groups/group-requests.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const notify = (type = 7, seq = '123', status = 1) => ({
  seq,
  type,
  status,
  group: { groupCode: '456' },
  postscript: 'verification message',
});
const identities = () => ({
  user1: { uid: 'u_applicant', nickName: ' Applicant\n' },
  user2: { uid: 'u_inviter', nickName: ' Inviter\n' },
  actionUser: { uid: 'u_action', nickName: 'Action user' },
});
function fixture() {
  const account = new AbortController();
  let listener!: GroupRequestListener;
  const calls: unknown[][] = [];
  const events: GroupRequest[] = [];
  const feature = createGroupRequests({
    signal: account.signal,
    awaitAlive: async (value) => value,
    getGroupService: () => ({
      addKernelGroupListener(value) {
        listener = value;
      },
      getSingleScreenNotifies(...args) {
        calls.push(['list', ...args]);
        return { result: 0 };
      },
      operateSysNotify(...args) {
        calls.push(['approve', ...args]);
      },
    }),
    emit(event, payload) {
      assert.equal(event, 'request.group');
      events.push(payload as GroupRequest);
    },
  });
  return {
    feature,
    account,
    calls,
    events,
    update(values: unknown[]) {
      listener.onGroupNotifiesUpdated(false, values);
    },
    page(values: unknown[]) {
      listener.onGroupSingleScreenNotifies(false, '', values);
    },
    async read(values: unknown[]) {
      const pending = feature.invokeOperation('listGroupRequests');
      await tick();
      listener.onGroupSingleScreenNotifies(false, '', values);
      const page = await pending;
      assert.ok(page);
      return page;
    },
  };
}

test('pending native requests expose only the exact source-backed participant in lists and events', async (t) => {
  const f = fixture();
  t.after(() => f.feature.close());
  const source = [7, 5, 1].map((type, index) => ({
    ...notify(type, String(index + 1)),
    ...identities(),
  }));
  const page = await f.read(source);
  assert.equal(page.requests.length, 3);
  assert.deepEqual(f.events, page.requests);
  for (const [index, request] of page.requests.entries()) {
    const expected: GroupRequestParticipant =
      request.type === 1
        ? { uid: 'u_inviter', nickname: ' Inviter\n' }
        : { uid: 'u_applicant', nickname: ' Applicant\n' };
    const key = request.type === 1 ? 'inviter' : 'applicant';
    assert.deepEqual(request[key], expected);
    assert.equal(Object.hasOwn(request, request.type === 1 ? 'applicant' : 'inviter'), false);
    assert.equal(Object.hasOwn(request, 'administrator'), false);
    assert.equal(Object.hasOwn(request, 'userId'), false);
    assert.equal(request.raw, source[index]);
    assert.notEqual(request[key], source[index][request.type === 1 ? 'user2' : 'user1']);
  }
  source[0].user1.uid = 'u_changed';
  source[0].user1.nickName = 'changed';
  source[2].user2 = { uid: 'u_changed', nickName: 'changed' };
  assert.deepEqual(page.requests[0].applicant, {
    uid: 'u_applicant',
    nickname: ' Applicant\n',
  });
  assert.deepEqual(f.events[2].inviter, { uid: 'u_inviter', nickname: ' Inviter\n' });
  assert.deepEqual(f.calls, [['list', false, '', 20]], 'identity projection performs no lookups');
});

test('processed and initial request states never inspect or assign participant roles', async (t) => {
  const f = fixture();
  t.after(() => f.feature.close());
  let reads = 0;
  const source = [0, 2, 3, 4].flatMap((status) =>
    [1, 5, 7].map(
      (type) =>
        new Proxy(
          { ...notify(type, `${status}${type}`, status), ...identities() },
          {
            getOwnPropertyDescriptor() {
              reads++;
              throw new Error('processed identity must not be inspected');
            },
          },
        ),
    ),
  );
  const page = await f.read(source);
  assert.equal(page.requests.length, 12);
  assert.equal(reads, 0);
  assert.deepEqual(f.events, []);
  for (const request of page.requests) {
    assert.equal(Object.hasOwn(request, 'applicant'), false);
    assert.equal(Object.hasOwn(request, 'inviter'), false);
  }
});

test('malformed optional carriers and UID descriptors omit only the participant without getters', async (t) => {
  const f = fixture();
  t.after(() => f.feature.close());
  let reads = 0;
  const getter = () => {
    reads++;
    throw new Error('optional getter must not run');
  };
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const carriers: unknown[] = [
    undefined,
    null,
    false,
    1,
    'u_wrong',
    () => {},
    Object.assign([], { uid: 'u_array' }),
    {},
    { uid: '' },
    { uid: ' \n' },
    { uid: 123 },
    { uid: { toString: getter } },
    Object.create({ uid: 'u_inherited' }),
    Object.defineProperty({}, 'uid', { get: getter }),
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('private descriptor details');
        },
      },
    ),
    revoked.proxy,
  ];
  const source: unknown[] = carriers.map((user1, index) => ({
    ...notify(7, String(index + 1)),
    user1,
  }));
  source.push(
    Object.defineProperty(notify(7, '101'), 'user1', { get: getter }),
    Object.assign(Object.create({ user1: { uid: 'u_inherited' } }), notify(7, '102')),
    new Proxy(notify(7, '103'), {
      getOwnPropertyDescriptor() {
        throw new Error('private carrier descriptor details');
      },
    }),
  );
  const page = await f.read(source);
  assert.equal(page.requests.length, source.length);
  assert.equal(f.events.length, source.length);
  assert.equal(reads, 0);
  assert.ok(page.requests.every((request) => !Object.hasOwn(request, 'applicant')));
  assert.deepEqual(f.calls, [['list', false, '', 20]]);
});

test('optional nickname uses own data without traversal, coercion or losing a valid UID', async (t) => {
  const f = fixture();
  t.after(() => f.feature.close());
  let reads = 0;
  const getter = () => {
    reads++;
    throw new Error('nickname getter must not run');
  };
  const carriers = [
    { uid: 'u_user' },
    { uid: 'u_user', nickName: null },
    { uid: 'u_user', nickName: 0 },
    { uid: 'u_user', nickName: '' },
    { uid: 'u_user', nickName: ' \n' },
    { uid: 'u_user', nickName: { toString: getter } },
    Object.defineProperty({ uid: 'u_user' }, 'nickName', { get: getter }),
    Object.assign(Object.create({ nickName: 'inherited' }), { uid: 'u_user' }),
    new Proxy({ uid: 'u_user' }, { ownKeys: getter, getPrototypeOf: getter, get: getter }),
  ];
  const page = await f.read(
    carriers.map((user2, index) => ({ ...notify(1, String(index + 1)), user2 })),
  );
  assert.equal(reads, 0);
  for (const request of page.requests) assert.deepEqual(request.inviter, { uid: 'u_user' });
  const valid = await f.read([
    {
      ...notify(1, '101'),
      user2: Object.assign(Object.create(null), { uid: ' u_user ', nickName: ' Name\n' }),
    },
  ]);
  assert.deepEqual(valid.requests[0].inviter, { uid: ' u_user ', nickname: ' Name\n' });
  const trapped = await f.read([
    {
      ...notify(1, '102'),
      user2: new Proxy(
        { uid: 'u_user' },
        {
          getOwnPropertyDescriptor(target, key) {
            if (key === 'nickName') throw new Error('private nickname descriptor details');
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        },
      ),
    },
  ]);
  assert.deepEqual(trapped.requests[0].inviter, { uid: 'u_user' });
});

test('invalid required later rows preserve whole-batch failure and do not consume event identity', async (t) => {
  const f = fixture();
  t.after(() => f.feature.close());
  const valid = { ...notify(), ...identities() };
  const invalid = { ...notify(1, '124'), ...identities(), postscript: null };
  f.update([valid, invalid]);
  assert.equal(f.events.length, 0);
  f.update([valid]);
  assert.deepEqual(f.events[0].applicant, { uid: 'u_applicant', nickname: ' Applicant\n' });
  const g = fixture();
  t.after(() => g.feature.close());
  await assert.rejects(g.read([valid, invalid]), /Invalid native group request message/);
  assert.deepEqual(g.events, []);
  await assert.rejects(g.feature.invokeOperation('listGroupRequests'), /query channel is invalid/);
  assert.equal(g.calls.length, 1);
});

test('participant descriptor retirement cannot emit an earlier request or complete a page', async (t) => {
  for (const callback of ['update', 'page'] as const) {
    for (const retirement of ['close', 'abort'] as const) {
      for (const field of ['user1', 'uid', 'nickName']) {
        for (const throws of [false, true]) {
          const f = fixture();
          t.after(() => f.feature.close());
          const reason = new Error('account retired during participant capture');
          const pending = assert.rejects(f.feature.invokeOperation('listGroupRequests'), (error) =>
            retirement === 'abort'
              ? error === reason
              : error instanceof Error && /closed/.test(error.message),
          );
          await tick();
          let inspected = 0;
          const handler = {
            getOwnPropertyDescriptor(target: object, key: string | symbol) {
              if (key === field) {
                inspected++;
                if (retirement === 'close') f.feature.close();
                else f.account.abort(reason);
                if (throws) throw new Error('private descriptor failure');
              }
              return Reflect.getOwnPropertyDescriptor(target, key);
            },
          };
          const raw = { ...notify(7, '124'), ...identities() };
          const trapped =
            field === 'user1'
              ? new Proxy(raw, handler)
              : { ...raw, user1: new Proxy(raw.user1, handler) };
          f[callback]([{ ...notify(), ...identities() }, trapped]);
          await pending;
          assert.equal(inspected, 1);
          assert.deepEqual(f.events, []);
          assert.deepEqual(f.calls, [['list', false, '', 20]]);
          f.page([{ ...notify(), ...identities() }]);
          assert.deepEqual(f.events, []);
        }
      }
    }
  }
});

test('participant display does not enter approval payloads or add native dispatch', async (t) => {
  const f = fixture();
  t.after(() => f.feature.close());
  f.update([{ ...notify(5), ...identities() }]);
  const request = f.events[0];
  assert.ok(request.applicant);
  Reflect.set(request.applicant, 'uid', 'u_other');
  await f.feature.invokeOperation('handleGroupRequest', {
    request,
    accept: false,
    reason: 'reviewed',
  });
  assert.deepEqual(f.calls, [
    [
      'approve',
      false,
      {
        operateType: 2,
        targetMsg: { seq: '123', type: 5, groupCode: '456', postscript: 'reviewed' },
      },
    ],
  ]);
});
