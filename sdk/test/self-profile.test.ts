import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelfProfile } from '../src/self-profile.ts';
function fixture(base: Record<string, unknown> = { longNick: 'preserve signature', sex: 255, birthday_year: 2000, birthday_month: 1, birthday_day: 2 }) {
  let listener: any;
  const calls: unknown[][] = [];
  const service = {
    addKernelProfileListener: (value: unknown) => { listener = value; return 3; },
    removeKernelProfileListener: (id: number) => calls.push(['remove', id]),
    fetchUserDetailInfo: async (...args: unknown[]) => { calls.push(['fetch', ...args]); listener.onUserDetailInfoChanged({ uid: 'other' }); listener.onUserDetailInfoChanged({ uid: 'self', simpleInfo: { baseInfo: base } }); return { result: 0 }; },
    modifyDesktopMiniProfile: async (payload: unknown) => { calls.push(['modify', payload]); return { result: 0 }; },
  };
  return { service, calls, client: createSelfProfile({ getProfileService: () => service }, () => 'self') };
}
test('nickname uses native self detail and preserves all required fields with exact mutation payload', async () => {
  const f = fixture();
  await f.client.invokeOperation('setNickname', { name: 'new nickname' });
  assert.deepEqual(f.calls, [['fetch', 'BuddyProfileStore', ['self'], 1, [0]], ['remove', 3], ['modify', { nick: 'new nickname', longNick: 'preserve signature', sex: 255, birthday: { birthday_year: '2000', birthday_month: '1', birthday_day: '2' }, location: undefined }]]);
});
test('invalid names and incomplete existing profiles do not mutate; native failures reject', async () => {
  const f = fixture({ longNick: 'signature' });
  await assert.rejects(f.client.invokeOperation('setNickname', { name: '' }), /nonempty/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.client.invokeOperation('setNickname', { name: 'new' }), /preserve/);
  assert.ok(!f.calls.some((call) => call[0] === 'modify'));
  const failed = fixture(); failed.service.modifyDesktopMiniProfile = async () => ({ result: 9 });
  await assert.rejects(failed.client.invokeOperation('setNickname', { name: 'new' }), { message: /update failed/, code: 9 });
});
test('lookup failure invalidates uncorrelated channel and close cancels pending lookup', async () => {
  const f = fixture(); f.service.fetchUserDetailInfo = async (...args) => { f.calls.push(['fetch', ...args]); return { result: 9 }; };
  await assert.rejects(f.client.invokeOperation('setNickname', { name: 'new' }), { message: /lookup failed/, code: 9 });
  await assert.rejects(f.client.invokeOperation('setNickname', { name: 'new' }), /recreate/);
  assert.equal(f.calls.filter((call) => call[0] === 'fetch').length, 1);
  const pending = fixture(); pending.service.fetchUserDetailInfo = async () => ({ result: 0 });
  const assertion = assert.rejects(pending.client.invokeOperation('setNickname', { name: 'new' }), /closed/);
  await new Promise((resolve) => setImmediate(resolve)); pending.client.close(); await assertion;
  assert.deepEqual(pending.calls, [['remove', 3]]);
});

test('actual lookup deadline blocks a late profile callback and later mutation attempts', async () => {
  let listener:any,fetches=0,modifications=0,removed=0;
  const service={
    addKernelProfileListener(value:any){listener=value;return 7;},
    removeKernelProfileListener(id:number){assert.equal(id,7);removed++;},
    async fetchUserDetailInfo(){fetches++;return {result:0};},
    async modifyDesktopMiniProfile(){modifications++;return {result:0};},
  };
  const client=createSelfProfile({getProfileService:()=>service},()=> 'self');
  try {
    await assert.rejects(client.invokeOperation('setNickname',{name:'never sent'}),/timed out/);
    listener.onUserDetailInfoChanged({uid:'self',simpleInfo:{baseInfo:{longNick:'keep',sex:0,birthday_year:0,birthday_month:0,birthday_day:0}}});
    await assert.rejects(client.invokeOperation('setNickname',{name:'also never sent'}),/recreate/);
    assert.equal(fetches,1);assert.equal(modifications,0);assert.equal(removed,1);
  } finally {client.close();}
});
