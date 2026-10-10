import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeServices } from '../src/native-services.ts';
const profile = {
  platform: 'darwin',
  arch: 'arm64',
  clientVersion: '7.0.2-53644',
  wrapperSha256: 'fbc8ad9b328d05e16784d76b0181dda894c17001179dbf8c0d5dd00dc6271358',
};
function fixture(verified = true) {
  let acquired = 0,
    registered = 0;
  let listener: { onSearchGroupResult: (value: unknown) => void } | undefined;
  const calls: unknown[] = [];
  const search = {
    addKernelSearchListener(value: unknown) {
      registered++;
      listener = value as typeof listener;
      return 'opaque';
    },
    searchGroup(params: { keyWords: string }) {
      calls.push(params);
      listener?.onSearchGroupResult({
        keyWord: params.keyWords,
        errorode: 0,
        isEnd: true,
        groupInfos: [
          {
            groupCode: '123',
            searchGroupInfo: {
              groupCode: '123',
              groupName: 'group',
              memberNum: 1,
              maxMemberNum: 10,
              ownerUid: 'u_owner',
              fingerMemo: 'description',
            },
          },
        ],
      });
      return { result: 0 };
    },
  };
  const api = createNativeServices({
    version: profile.clientVersion,
    binaryProfile: verified ? profile : undefined,
    events: { emit() {} },
    session: {
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getSearchService() {
        acquired++;
        return search;
      },
    },
  });
  return {
    api,
    calls,
    acquired: () => acquired,
    registered: () => registered,
    listener: () => listener,
  };
}
test('Search is gated before acquisition and registered lazily once', async () => {
  const bad = fixture(false);
  await assert.rejects(bad.api.invokeOperation('searchGroup', { groupId: '123' }), {
    code: 'unsupported-native-contract',
  });
  assert.equal(bad.acquired(), 0);
  bad.api.close();
  const f = fixture();
  assert.equal(f.acquired(), 0);
  assert.equal(f.registered(), 0);
  const result = await f.api.invokeOperation('searchGroup', { groupId: '00123' });
  assert.deepEqual(result, {
    groupId: '123',
    name: 'group',
    memberCount: 1,
    maxMemberCount: 10,
    ownerUid: 'u_owner',
    description: 'description',
  });
  await f.api.invokeOperation('searchGroup', { groupId: '123' });
  assert.equal(f.registered(), 1);
  assert.equal(f.acquired(), 1);
  f.api.close();
  await assert.rejects(f.api.invokeOperation('searchGroup', { groupId: '123' }));
  f.listener()?.onSearchGroupResult({ keyWord: '123', errorode: 0, isEnd: true, groupInfos: [] });
  assert.equal(f.calls.length, 2);
});

test('fallible Search registration is never replayed and close during registration sends nothing', async () => {
  for (const closeDuringAdd of [false, true]) {
    let add = 0,
      queries = 0;
    let retained: Record<string, (value: unknown) => void> | undefined;
    const failure = Error('synthetic registration failed');
    const api = createNativeServices({
      version: profile.clientVersion,
      binaryProfile: profile,
      events: { emit() {} },
      session: {
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getSearchService: () => ({
          addKernelSearchListener(value: unknown) {
            add++;
            retained = value as typeof retained;
            if (closeDuringAdd) api.close();
            throw failure;
          },
          searchGroup() {
            queries++;
            return { result: 0 };
          },
        }),
      },
    });
    await assert.rejects(api.invokeOperation('searchGroup', { groupId: '123' }));
    await assert.rejects(api.invokeOperation('searchGroup', { groupId: '123' }));
    assert.equal(add, 1);
    assert.equal(queries, 0);
    api.close();
    retained?.onSearchGroupResult?.({ keyWord: '123', errorode: 0, isEnd: true, groupInfos: [] });
  }
});
