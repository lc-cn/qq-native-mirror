import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeServices } from '../src/native-services.ts';
import { projectGroupInfo } from '../src/group-events.ts';

const raw = (groupCode = '000123') => ({ groupCode, groupName: '群', ownerUid: 'u_owner', ownerUin: '900719925474099312345', memberNum: 2, maxMemberNum: 200, fingerMemo: '' });
const dto = (groupId = '000123') => ({ groupId, name: '群', ownerUid: 'u_owner', ownerUserId: '900719925474099312345', memberCount: 2, maxMemberCount: 200, description: '' });
function fixture(invoke: (...args: unknown[]) => unknown) {
  const listeners: any[] = [], calls: unknown[][] = [];
  const services = createNativeServices({
    getMsgService: () => ({ addKernelMsgListener() {} }),
    getGroupService: () => ({ addKernelGroupListener(listener: unknown) { listeners.push(listener); return listeners.length; },
      getGroupDetailInfo(...args: unknown[]) { calls.push(args); return invoke(...args); } }),
    getBuddyService: () => ({ addKernelBuddyListener() {} }),
  }, '7.0.2-53644', () => {});
  return { services, calls, detail(value: unknown) { for (const listener of listeners) listener.onGroupDetailInfoChange(value); } };
}

test('group detail waits for both native success and matching callback, coalesces only same ID and isolates returned DTOs', async () => {
  let finish!: (value: unknown) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    let done = false;
    const first = f.services.invokeOperation('getGroupInfo', { groupId: '000123' }).then(value => { done = true; return value; });
    const second = f.services.invokeOperation('getGroupInfo', { groupId: '000123' });
    assert.deepEqual(f.calls, [['000123', 2]]);
    f.detail(raw('456')); f.detail(raw());
    await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
    finish({ result: 0 });
    const a = await first, b = await second;
    assert.deepEqual(a, dto()); assert.deepEqual(b, dto()); assert.notEqual(a, b);
    (a as any).name = 'mutated'; assert.equal((b as any).name, '群');
  } finally { f.services.close(); }
});

test('explicit native rejection overrides an early callback and prevents late-result retry on that group only', async () => {
  const f = fixture(() => ({ result: 73, errMsg: 'denied' }));
  try {
    const pending = f.services.invokeOperation('getGroupInfo', { groupId: '000123' }); f.detail(raw());
    await assert.rejects(pending, error => (error as any).code === 73);
    f.detail(raw());
    await assert.rejects(f.services.invokeOperation('getGroupInfo', { groupId: '000123' }), /channel is invalid/);
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.services.invokeOperation('getGroupInfo', { groupId: '456' }), error => (error as any).code === 73);
    assert.deepEqual(f.calls[1], ['456', 2]);
  } finally { f.services.close(); }
});

test('malformed matching detail fails atomically and never exposes partial or secret fields', async () => {
  const f = fixture(() => ({ result: 0 }));
  try {
    const pending = f.services.invokeOperation('getGroupInfo', { groupId: '000123' });
    f.detail({ ...raw(), memberNum: -1, credential: 'fixture-secret' });
    await assert.rejects(pending, /Invalid native group detail/);
    await assert.rejects(f.services.invokeOperation('getGroupInfo', { groupId: '000123' }), /channel is invalid/);
  } finally { f.services.close(); }
  let getters = 0;
  assert.throws(() => projectGroupInfo({ ...raw(), get groupName() { getters++; return 'invalid'; } }), /Invalid native group detail/);
  assert.equal(getters, 0);
  assert.deepEqual(projectGroupInfo({ ...raw(), credential: 'fixture-secret' }), dto());
});

test('group detail deadline interrupts pending invocation; close interrupts either phase and suppresses late completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timed = fixture(() => new Promise(() => {}));
  const rejected = assert.rejects(timed.services.invokeOperation('getGroupInfo', { groupId: '000123' }), /timed out/);
  t.mock.timers.tick(5000); await rejected;
  await assert.rejects(timed.services.invokeOperation('getGroupInfo', { groupId: '000123' }), /channel is invalid/); timed.services.close();
  for (const returned of [() => new Promise(() => {}), () => ({ result: 0 })]) {
    const f = fixture(returned);
    const stopped = assert.rejects(f.services.invokeOperation('getGroupInfo', { groupId: '000123' }), /closed|abort/i);
    f.services.close(); await stopped; f.detail(raw());
    await assert.rejects(f.services.invokeOperation('getGroupInfo', { groupId: '000123' }), /closed/);
  }
});

test('invalid group identifiers are rejected before dispatch without numeric/object coercion', async () => {
  const f = fixture(() => ({ result: 0 })); let coercions = 0;
  try {
    for (const groupId of [undefined, 123, '', '0', 'bad', { toString() { coercions++; return '123'; } }]) {
      await assert.rejects(f.services.invokeOperation('getGroupInfo', { groupId }));
    }
    assert.equal(f.calls.length, 0); assert.equal(coercions, 0);
  } finally { f.services.close(); }
});


test('actual native Msg listener routes membership events once without identity lookups and drops callbacks after close', () => {
  let listener:any;const events:unknown[]=[];
  const services=createNativeServices({
    getMsgService:()=>({addKernelMsgListener(value:any){listener=value;}}),
    getGroupService:()=>({addKernelGroupListener(){}}),
    getBuddyService:()=>({addKernelBuddyListener(){}}),
    getUixConvertService:()=>{throw Error('unexpected identity lookup');},
  },'7.0.2-53644',(name,value)=>events.push([name,value]));
  const packet=[18,2,8,34,26,7,18,5,8,123,32,130,1];
  listener.onRecvSysMsg(packet);listener.onRecvSysMsg(packet);
  assert.deepEqual(events,[['group-membership',{groupId:'123',direction:'decrease',code:130,kind:'leave'}]]);
  services.close();listener.onRecvSysMsg(packet);listener.onRecvSysMsg([]);assert.equal(events.length,1);
});
