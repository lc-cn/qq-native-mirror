import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContactDirectory } from '../src/features/contacts/contact-directory.ts';
const profile = (uid = 'u_a', uin = '123') => ({
  coreInfo: { uid, uin, nick: 'fixture', remark: '' },
});
const category = () => ({
  categoryId: 1,
  categorySortId: 2,
  categroyName: 'friends',
  categroyMbCount: 3,
  onlineCount: 1,
  buddyUids: ['u_a', 'u_a'],
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(version = '7.0.2-53644') {
  const calls: { method: string; args: unknown[] }[] = [];
  let buddy: unknown = { result: 0, data: [{ buddyUids: ['u_a'] }] };
  let profiles: unknown = new Map([['u_a', profile()]]);
  const directory = createContactDirectory({
    signal: new AbortController().signal,
    version,
    getBuddyService: () => ({
      getBuddyListV2(...args) {
        calls.push({ method: 'getBuddyListV2', args });
        return buddy;
      },
    }),
    getProfileService: () => ({
      getCoreAndBaseInfo(...args) {
        calls.push({ method: 'getCoreAndBaseInfo', args });
        return profiles;
      },
    }),
    getUidService: () => ({
      getUid(...args) {
        calls.push({ method: 'getUid', args });
        return { uidInfo: new Map([[args[0][0], 'u_converted']]) };
      },
    }),
    awaitAlive: async (value) => value,
  });
  return {
    directory,
    calls,
    setBuddy(value: unknown) {
      buddy = value;
    },
    setProfiles(value: unknown) {
      profiles = value;
    },
  };
}
test('validated friend/member cache avoids lookup, opaque UID passes through and converted misses remain uncached', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  assert.equal(await f.directory.uidFor('u_opaque'), 'u_opaque');
  assert.equal(f.calls.length, 0);
  await f.directory.listFriends();
  assert.deepEqual(
    f.calls.map((value) => value.method),
    ['getBuddyListV2', 'getCoreAndBaseInfo'],
  );
  assert.equal(await f.directory.uidFor('123'), 'u_a');
  f.directory.rememberMembers([
    { userId: '456', uid: 'u_member', nickname: '', card: '', role: 'member' },
  ]);
  assert.equal(await f.directory.uidFor('456'), 'u_member');
  await f.directory.uidFor('999');
  await f.directory.uidFor('999');
  assert.equal(f.calls.filter((value) => value.method === 'getUid').length, 2);
  f.directory.close();
  await assert.rejects(f.directory.uidFor('123'), /closed/);
});
test('failed later profile row cannot cache a valid earlier row and sparse UID batch never queries Profile', async () => {
  const f = fixture();
  f.setBuddy({ result: 0, data: [{ buddyUids: ['u_a', 'u_b'] }] });
  f.setProfiles(
    new Map<string, unknown>([
      ['u_a', profile()],
      ['u_b', { coreInfo: { uid: 'u_b', uin: '456', remark: false } }],
    ]),
  );
  await assert.rejects(f.directory.listFriends(), /profile/);
  assert.equal(await f.directory.uidFor('123'), 'u_converted');
  f.setBuddy({ result: 0, data: [{ buddyUids: Array(1) }] });
  const before = f.calls.filter((value) => value.method === 'getCoreAndBaseInfo').length;
  await assert.rejects(f.directory.listFriends(), /UID/);
  assert.equal(f.calls.filter((value) => value.method === 'getCoreAndBaseInfo').length, before);
  f.directory.close();
});
test('categories snapshot precedes awaited profile and preserves duplicate memberships/native counts', async () => {
  const f = fixture();
  const raw = category();
  f.setBuddy({ result: 0, data: [raw] });
  let resolve!: (value: unknown) => void;
  f.setProfiles(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = f.directory.listFriendCategories();
  await tick();
  raw.categroyName = 'mutated';
  raw.buddyUids[0] = 'u_changed';
  resolve(new Map([['u_a', profile()]]));
  const values = await pending;
  assert.equal(values[0].name, 'friends');
  assert.equal(values[0].memberCount, 3);
  assert.equal(values[0].friends.length, 2);
  assert.equal(values[0].friends[0].uid, 'u_a');
  assert.equal(await f.directory.uidFor('123'), 'u_a');
  f.directory.close();
});
test('unsupported version rejects before any service operation', async () => {
  const f = fixture('unknown');
  await assert.rejects(f.directory.listFriends(), /signature/);
  await assert.rejects(f.directory.listFriendCategories(), /signature/);
  assert.equal(f.calls.length, 0);
  f.directory.close();
});
for (const stage of ['buddy', 'profile'])
  test(`close while ${stage} stalls prevents late cache or subsequent dispatch`, async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    const stall = new Promise((done) => {
      resolve = done;
    });
    if (stage === 'buddy') f.setBuddy(stall);
    else f.setProfiles(stall);
    const pending = assert.rejects(f.directory.listFriends(), /closed/);
    await tick();
    f.directory.close();
    resolve(
      stage === 'buddy'
        ? { result: 0, data: [{ buddyUids: ['u_a'] }] }
        : new Map([['u_a', profile()]]),
    );
    await pending;
    await assert.rejects(f.directory.uidFor('123'), /closed/);
    assert.equal(f.calls.length, stage === 'buddy' ? 1 : 2);
  });

for (const family of ['buddy', 'profile', 'uid'])
  for (const stage of ['service', 'method', 'call'])
    for (const termination of ['close', 'abort'])
      test(`${family} ${stage} synchronous ${termination} prevents subsequent dispatch or cache`, async () => {
        const controller = new AbortController();
        const calls: string[] = [];
        const terminate = () => (termination === 'close' ? directory.close() : controller.abort());
        const get = (name: string) => {
          if (family === name && stage === 'service') terminate();
          const service = {
            get getBuddyListV2() {
              if (family === 'buddy' && stage === 'method') terminate();
              return function (this: unknown) {
                assert.equal(this, service);
                calls.push('buddy');
                if (family === 'buddy' && stage === 'call') terminate();
                return { result: 0, data: [{ buddyUids: ['u_a'] }] };
              };
            },
            get getCoreAndBaseInfo() {
              if (family === 'profile' && stage === 'method') terminate();
              return function (this: unknown) {
                assert.equal(this, service);
                calls.push('profile');
                if (family === 'profile' && stage === 'call') terminate();
                return new Map([['u_a', profile()]]);
              };
            },
            get getUid() {
              if (family === 'uid' && stage === 'method') terminate();
              return function (this: unknown) {
                assert.equal(this, service);
                calls.push('uid');
                if (family === 'uid' && stage === 'call') terminate();
                return { uidInfo: new Map([['123', 'u_a']]) };
              };
            },
          };
          return service;
        };
        const directory = createContactDirectory({
          signal: controller.signal,
          version: '7.0.2-53644',
          getBuddyService: () => get('buddy'),
          getProfileService: () => get('profile'),
          getUidService: () => get('uid'),
          awaitAlive: async (value) => value,
        });
        await assert.rejects(family === 'uid' ? directory.uidFor('123') : directory.listFriends());
        assert.deepEqual(
          calls,
          family === 'profile'
            ? stage === 'call'
              ? ['buddy', 'profile']
              : ['buddy']
            : stage === 'call'
              ? [family]
              : [],
        );
        await assert.rejects(directory.uidFor('u_cached'));
        directory.close();
      });

test('missing narrow methods reject explicitly without later services', async () => {
  let profileGets = 0;
  const directory = createContactDirectory({
    signal: new AbortController().signal,
    version: '7.0.2-53644',
    getBuddyService: () => ({}),
    getProfileService: () => {
      profileGets++;
      return {};
    },
    getUidService: () => ({}),
    awaitAlive: async (value) => value,
  });
  await assert.rejects(directory.listFriends(), /missing getBuddyListV2/);
  await assert.rejects(directory.uidFor('123'), /missing getUid/);
  assert.equal(profileGets, 0);
  directory.close();
});

test('native port failure identity is preserved without retry', async () => {
  const error = Object.assign(Error('synthetic'), { code: 23 });
  let calls = 0;
  const directory = createContactDirectory({
    signal: new AbortController().signal,
    version: '7.0.2-53644',
    getBuddyService: () => ({
      getBuddyListV2() {
        calls++;
        throw error;
      },
    }),
    getProfileService: () => ({}),
    getUidService: () => ({}),
    awaitAlive: async (value) => value,
  });
  await assert.rejects(directory.listFriends(), (received: unknown) => received === error);
  assert.equal(calls, 1);
  directory.close();
});

test('missing Profile method rejects after valid Buddy batch with no cache commit', async () => {
  const directory = createContactDirectory({
    signal: new AbortController().signal,
    version: '7.0.2-53644',
    getBuddyService: () => ({
      getBuddyListV2: () => ({ result: 0, data: [{ buddyUids: ['u_a'] }] }),
    }),
    getProfileService: () => ({}),
    getUidService: () => ({ getUid: () => ({ uidInfo: new Map([['123', 'u_uncached']]) }) }),
    awaitAlive: async (value) => value,
  });
  await assert.rejects(directory.listFriends(), /missing getCoreAndBaseInfo/);
  assert.equal(await directory.uidFor('123'), 'u_uncached');
  directory.close();
});

for (const absent of [undefined, null])
  for (const family of ['buddy', 'profile', 'uid'])
    test(`${family} absent service ${String(absent)} preserves missing-method error`, async () => {
      const directory = createContactDirectory({
        signal: new AbortController().signal,
        version: '7.0.2-53644',
        getBuddyService: () =>
          family === 'buddy' ? absent : { getBuddyListV2: () => ({ result: 0, data: [] }) },
        getProfileService: () => (family === 'profile' ? absent : {}),
        getUidService: () => absent,
        awaitAlive: async (value) => value,
      });
      const method =
        family === 'buddy'
          ? 'getBuddyListV2'
          : family === 'profile'
            ? 'getCoreAndBaseInfo'
            : 'getUid';
      await assert.rejects(family === 'uid' ? directory.uidFor('123') : directory.listFriends(), {
        message: `Native service is missing ${method}`,
      });
      directory.close();
    });
