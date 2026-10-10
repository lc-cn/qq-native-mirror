import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupSearch } from '../src/features/groups/group-search.ts';
import { createNativeEventChannel } from '../src/runtime/native-event-channel.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';
function fixture() {
  const life = new NativeServiceLifetime(),
    channel = createNativeEventChannel(life.signal);
  let calls = 0;
  const params: unknown[] = [];
  const raw = (id = '123') => ({
    keyWord: '00123',
    errorode: 0,
    isEnd: true,
    groupInfos: [
      {
        groupCode: id,
        searchGroupInfo: {
          groupCode: id,
          groupName: 'n',
          memberNum: 1,
          maxMemberNum: 2,
          ownerUid: 'u_owner',
          fingerMemo: 'finger',
          groupMemo: 'memo',
        },
      },
    ],
  });
  let response: unknown = raw();
  let ack: unknown = { result: 0 };
  const service = {
    searchGroup(input: unknown) {
      assert.equal(this, service);
      calls++;
      params.push(input);
      channel.dispatch('Search/onSearchGroupResult', [response]);
      return ack;
    },
  };
  const api = createGroupSearch({
    signal: life.signal,
    awaitAlive: life.awaitAlive,
    eventCall: channel.call,
    getSearchService: () => service,
  });
  return {
    api,
    life,
    channel,
    raw,
    params,
    calls: () => calls,
    setResponse(v: unknown) {
      response = v;
    },
    setAck(v: unknown) {
      ack = v;
    },
  };
}
test('search exact ABI, numeric namespace, coalescing and independent caller DTO', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.api.searchGroup('00123'), f.api.searchGroup('00123')]);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.params, [
    { keyWords: '00123', groupNum: 25, exactSearch: false, penetrate: '' },
  ]);
  assert.equal(a?.description, 'finger');
  assert.notEqual(a, b);
  f.api.close();
  f.life.close();
});
test('endmarker absent target returns undefined; native ACK failure wins callback', async () => {
  const f = fixture();
  f.setResponse({ ...f.raw(), groupInfos: [] });
  assert.equal(await f.api.searchGroup('00123'), undefined);
  f.setResponse(f.raw());
  f.setAck({ result: 8 });
  await assert.rejects(f.api.searchGroup('00123'), { code: 8 });
  await assert.rejects(f.api.searchGroup('00123'), /invalidated/);
  assert.equal(f.calls(), 2);
  f.api.close();
  f.life.close();
});
test('sparse or mismatched batch rejects without partial match', async () => {
  for (const bad of [
    [filler(), undefined],
    [
      filler(),
      { groupCode: '124', searchGroupInfo: { ...filler().searchGroupInfo, groupCode: '125' } },
    ],
  ]) {
    const f = fixture();
    f.setResponse({ ...f.raw(), groupInfos: bad });
    await assert.rejects(f.api.searchGroup('00123'));
    f.api.close();
    f.life.close();
  }
  function filler() {
    return {
      groupCode: '123',
      searchGroupInfo: {
        groupCode: '123',
        groupName: 'n',
        memberNum: 1,
        maxMemberNum: 2,
        ownerUid: 'u_o',
        fingerMemo: '',
      },
    };
  }
});
test('close interrupts stalled native completion and late rejection is observed', async () => {
  const f = fixture();
  let reject!: (e: unknown) => void;
  f.setAck(
    new Promise((_, r) => {
      reject = r;
    }),
  );
  const pending = f.api.searchGroup('00123');
  await new Promise<void>((r) => setImmediate(r));
  f.api.close();
  await assert.rejects(pending, /closed/);
  reject(Error('late'));
  await new Promise<void>((r) => setImmediate(r));
  f.life.close();
});

test('invalid input gets no service and callback accessor is not executed', async () => {
  const f = fixture();
  assert.throws(() => f.api.searchGroup('18446744073709551616'));
  assert.equal(f.calls(), 0);
  let reads = 0;
  const raw = f.raw();
  Object.defineProperty(raw, 'errorode', {
    get() {
      reads++;
      return 0;
    },
  });
  f.setResponse(raw);
  await assert.rejects(f.api.searchGroup('00123'), /Invalid native/);
  assert.equal(reads, 0);
  f.api.close();
  f.life.close();
});
test('duplicate native identity rejects whole callback; nonzero code preserved', async () => {
  const f = fixture();
  const raw = f.raw();
  raw.groupInfos.push({ ...raw.groupInfos[0]! });
  f.setResponse(raw);
  await assert.rejects(f.api.searchGroup('00123'), /identities/);
  f.api.close();
  f.life.close();
  const g = fixture();
  g.setResponse({ ...g.raw(), errorode: 7 });
  await assert.rejects(g.api.searchGroup('00123'), { code: 7 });
  g.api.close();
  g.life.close();
});
test('service or method acquisition close prevents native dispatch', async () => {
  for (const phase of ['service', 'method']) {
    const life = new NativeServiceLifetime(),
      channel = createNativeEventChannel(life.signal);
    let calls = 0;
    const service = {
      get searchGroup() {
        if (phase === 'method') api.close();
        return () => {
          calls++;
          return { result: 0 };
        };
      },
    };
    const api = createGroupSearch({
      signal: life.signal,
      awaitAlive: life.awaitAlive,
      eventCall: channel.call,
      getSearchService() {
        if (phase === 'service') api.close();
        return service;
      },
    });
    await assert.rejects(api.searchGroup('123'), /closed/);
    assert.equal(calls, 0);
    api.close();
    life.close();
  }
});
test('callback projection proxy retirement cannot publish a match', async () => {
  const f = fixture();
  const raw = f.raw();
  f.setResponse(
    new Proxy(raw, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'isEnd') f.api.close();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    }),
  );
  await assert.rejects(f.api.searchGroup('00123'), /closed/);
  f.life.close();
});

test('different targets serialize and an incomplete empty callback is not absence', async () => {
  const life = new NativeServiceLifetime(),
    channel = createNativeEventChannel(life.signal);
  const calls: string[] = [];
  const api = createGroupSearch({
    signal: life.signal,
    awaitAlive: life.awaitAlive,
    eventCall: channel.call,
    getSearchService: () => ({
      searchGroup(p) {
        calls.push(p.keyWords);
        return { result: 0 };
      },
    }),
  });
  const first = api.searchGroup('123'),
    second = api.searchGroup('124');
  await new Promise<void>((r) => setImmediate(r));
  assert.deepEqual(calls, ['123']);
  channel.dispatch('Search/onSearchGroupResult', [
    { keyWord: '123', errorode: 0, isEnd: false, groupInfos: [] },
  ]);
  await new Promise<void>((r) => setImmediate(r));
  assert.deepEqual(calls, ['123']);
  channel.dispatch('Search/onSearchGroupResult', [
    { keyWord: '123', errorode: 0, isEnd: true, groupInfos: [] },
  ]);
  assert.equal(await first, undefined);
  await new Promise<void>((r) => setImmediate(r));
  assert.deepEqual(calls, ['123', '124']);
  channel.dispatch('Search/onSearchGroupResult', [
    { keyWord: '124', errorode: 0, isEnd: true, groupInfos: [] },
  ]);
  assert.equal(await second, undefined);
  api.close();
  life.close();
});
test('failed first request quarantines queued target without a second dispatch', async () => {
  const f = fixture();
  f.setAck({ result: 9 });
  const first = f.api.searchGroup('00123'),
    second = f.api.searchGroup('124');
  await assert.rejects(first, { code: 9 });
  await assert.rejects(second, /invalidated/);
  assert.equal(f.calls(), 1);
  f.api.close();
  f.life.close();
});
