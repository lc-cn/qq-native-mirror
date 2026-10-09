import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContactOperations } from '../src/contact-operations.ts';

test('profile normalizes pinned native Map and returns raw profile', async () => {
  const raw = { coreInfo: { uin: '123', nick: '昵称', remark: '备注' }, baseInfo: {} };
  const operations = createContactOperations({ getProfileService: () => ({ getCoreAndBaseInfo: (from: string, ids: string[]) => {
    assert.equal(from, 'nodeStore'); assert.deepEqual(ids, ['u_uid']); return new Map([['u_uid', raw]]);
  } }) }, async id => { assert.equal(id, '123'); return 'u_uid'; });
  assert.deepEqual(await operations.invokeOperation('getUserProfile', { userId: '123' }), { userId: '123', uid: 'u_uid', nickname: '昵称', remark: '备注', raw });
});

test('friend mutations use explicit pinned payloads and void means dispatch only', async () => {
  const calls: unknown[] = [];
  const operations = createContactOperations({ getBuddyService: () => ({
    setBuddyRemark: (payload: unknown) => { calls.push(payload); },
    delBuddy: async (payload: unknown) => { calls.push(payload); return { result: 0 }; },
  }) }, async () => 'u_uid');
  assert.equal(calls.length, 0);
  await operations.invokeOperation('setFriendRemark', { userId: '123', remark: '' });
  await operations.invokeOperation('deleteFriend', { userId: '123' });
  await operations.invokeOperation('deleteFriend', { userId: '123', options: { block: true, both: true } });
  assert.deepEqual(calls, [{ uid: 'u_uid', remark: '' }, { friendUid: 'u_uid', tempBlock: false, tempBothDel: false }, { friendUid: 'u_uid', tempBlock: true, tempBothDel: true }]);
});

test('invalid requests fail before UID lookup; native errors and profile mismatch propagate', async () => {
  let resolved = 0;
  const operations = createContactOperations({}, async () => { resolved++; return 'u_uid'; });
  await assert.rejects(operations.invokeOperation('getUserProfile', { userId: 'bad' }));
  await assert.rejects(operations.invokeOperation('setFriendRemark', { userId: '123', remark: 1 }));
  await assert.rejects(operations.invokeOperation('deleteFriend', { userId: '123', options: { block: 'yes' } }));
  assert.equal(resolved, 0);
  for (const result of [{ result: 7 }, {}, null]) {
    const bad = createContactOperations({ getBuddyService: () => ({ delBuddy: () => result }) }, async () => 'u_uid');
    await assert.rejects(bad.invokeOperation('deleteFriend', { userId: '123' }), /failed/);
  }
  for (const profiles of [new Map(), {}, new Map([['u_uid', { coreInfo: { uin: '999' } }]])]) {
    const bad = createContactOperations({ getProfileService: () => ({ getCoreAndBaseInfo: () => profiles }) }, async () => 'u_uid');
    await assert.rejects(bad.invokeOperation('getUserProfile', { userId: '123' }));
  }
  await assert.rejects(operations.invokeOperation('getUserProfile', { userId: '123' }), /missing/);
});

test('friend mutation failures preserve explicit vendor codes and reject nonfinite or malformed codes', async () => {
  for (const [result,code] of [
    [{result:7},7], [{result:'ACCOUNT_OFFLINE'},'ACCOUNT_OFFLINE'],
    [{result:NaN},'invalid-result'], [{result:Infinity},'invalid-result'],
    [{result:null},'invalid-result'], [{},'invalid-result'],
  ] as const) {
    const operations=createContactOperations({getBuddyService:()=>({delBuddy:()=>result})},async()=> 'u_uid');
    await assert.rejects(operations.invokeOperation('deleteFriend',{userId:'123'}),error=> {
      assert.equal((error as Error & {code:unknown}).code,code);return true;
    });
  }
});
