import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeServices } from '../src/native-services.ts';

function fixture(version = '7.0.2-53644') {
  let msgListener: any;
  const groupListeners: any[] = [];
  const sentCalls: any[][] = [];
  const events: any[] = [];
  const msg = {
    addKernelMsgListener(listener: any) { msgListener = listener; },
    generateMsgUniqueId(chatType: number, time: string) { assert.equal(chatType, 2); assert.equal(time, '100'); return 'unique'; },
    sendMsg(...args: any[]) {
      sentCalls.push(args);
      msgListener.onMsgInfoListUpdate([{ guildId: 'unrelated', sendStatus: 2 }]);
      msgListener.onMsgInfoListUpdate([{ guildId: 'unique', sendStatus: 1 }]);
      queueMicrotask(() => msgListener.onMsgInfoListUpdate([{ guildId: 'unique', sendStatus: 2, msgId: '42', msgSeq: '9', msgTime: '100' }]));
      return Promise.resolve({ result: 0 });
    },
    getMsgsIncludeSelf(peer: any, before: string, count: number, reverse: boolean) { assert.equal(peer.peerUid, '123'); assert.equal(before, '42'); assert.equal(count, 2); assert.equal(reverse, false); return { msgList: [] }; },
  };
  const session = {
    getMsgService: () => msg,
    getGroupService: () => ({ addKernelGroupListener(listener: any) { groupListeners.push(listener); return groupListeners.length; }, removeKernelGroupListener(id: number) { groupListeners[id - 1] = undefined; }, getGroupList() { for (const listener of groupListeners.filter(Boolean)) { listener.onGroupListUpdate(4, []); listener.onGroupListUpdate(2, []); listener.onGroupListUpdate(1, [{ groupCode: '123', groupName: 'group', memberCount: 2, maxMember: 100 }]); } return {result:0}; } }),
    getMSFService: () => ({ getServerTime: () => '100' }),
    getBuddyService: () => ({ addKernelBuddyListener() { return 1; }, getBuddyListV2(...args: any[]) { assert.deepEqual(args, ['0', true, 0]); return { result: 0, data: [{ buddyUids: ['u_a'] }] }; } }),
    getProfileService: () => ({ getCoreAndBaseInfo(store: string, uids: string[]) { assert.equal(store, 'nodeStore'); assert.deepEqual(uids, ['u_a']); return new Map([['u_a', { coreInfo: { uin: '456', nick: 'friend', remark: 'remark' } }]]); } }),
  };
  return { services: createNativeServices(session, version, (event, value) => events.push([event, value])), sentCalls, events, msg, listener: () => msgListener };
}

test('signature dispatch uses the authenticated UID and Session close cancels a pending profile mutation', async () => {
  let profileListener: any;
  let holdLookup = false;
  const writes: unknown[] = [];
  const detail = { uid: 'u_self', simpleInfo: { coreInfo: { nick: 'existing nickname' }, baseInfo: { longNick: 'old', sex: 255, birthday_year: 2000, birthday_month: 1, birthday_day: 2 } } };
  const session = {
    getMsgService: () => ({ addKernelMsgListener() {} }),
    getGroupService: () => ({ addKernelGroupListener() { return 1; } }),
    getBuddyService: () => ({ addKernelBuddyListener() { return 1; } }),
    getProfileService: () => ({
      addKernelProfileListener(listener: any) { profileListener = listener; return 3; },
      removeKernelProfileListener(id: number) { assert.equal(id, 3); },
      async fetchUserDetailInfo(store: string, uids: string[], source: number, fields: number[]) {
        assert.deepEqual([store, uids, source, fields], ['BuddyProfileStore', ['u_self'], 1, [0]]);
        if (!holdLookup) profileListener.onUserDetailInfoChanged(detail);
        return { result: 0 };
      },
      async modifyDesktopMiniProfile(value: unknown) { writes.push(value); return { result: 0 }; },
    }),
  };
  const services = createNativeServices(session, '7.0.2-53644', () => {}, undefined, undefined, '456', 'u_self');
  try {
    await services.invokeOperation('setSignature', { text: '' });
    assert.deepEqual(writes, [{ nick: 'existing nickname', longNick: '', sex: 255, birthday: { birthday_year: '2000', birthday_month: '1', birthday_day: '2' }, location: undefined }]);
    holdLookup = true;
    const stopped = assert.rejects(services.invokeOperation('setSignature', { text: 'must not be written' }), /closed/);
    await new Promise(resolve => setImmediate(resolve));
    services.close();
    await stopped;
    profileListener.onUserDetailInfoChanged(detail);
    await assert.rejects(services.invokeOperation('setSignature', { text: 'closed' }), /closed/);
    assert.equal(writes.length, 1, 'late profile callbacks cannot cause a new write');
  } finally { services.close(); }
});

test('send correlates successful native update and encodes text without mutating peer', async () => {
  const { services, sentCalls } = fixture();
  try {
    const sent = await services.invokeOperation('sendGroupMessage', { groupId: '123', message: 'hello' });
    assert.deepEqual(sent, { messageId: '42', sequence: '9', time: 100 });
    assert.equal(sentCalls.length, 1);
    assert.deepEqual(sentCalls[0]?.slice(0, 3), ['0', { chatType: 2, peerUid: '123', guildId: 'unique' }, [{ elementType: 1, elementId: '', textElement: { content: 'hello', atType: 0, atUid: '', atTinyId: '', atNtUid: '' } }]]);
    assert.ok(sentCalls[0]?.[3] instanceof Map);
  } finally { services.close(); }
});

for (const version of ['7.0.2-53644', '3.2.32-52194', '9.9.33-52230']) test(`read-only lists and history map contract fields for ${version}`, async () => {
  const { services } = fixture(version);
  try {
    assert.deepEqual(await services.invokeOperation('listFriends'), [{ userId: '456', uid: 'u_a', nickname: 'friend', remark: 'remark' }]);
    assert.deepEqual(await services.invokeOperation('listGroups'), [{ groupId: '123', name: 'group', memberCount: 2, maxMemberCount: 100 }]);
    assert.deepEqual(await services.invokeOperation('getHistory', { peer: { type: 'group', groupId: '123' }, options: { before: '42', limit: 2 } }), []);
  } finally { services.close(); }
});

test('incoming message emits typed message once with raw evidence retained', () => {
  const { services, events, listener } = fixture();
  const raw = { msgId: '1', msgSeq: '2', msgTime: '100', chatType: 1, peerUid: 'u_a', peerUin: '456', senderUin: '456', senderUid: 'u_a', sendNickName: 'friend', elements: [{ textElement: { content: 'hi', atType: 0 } }] };
  listener().onRecvMsg([raw]);
  assert.equal(events[0][0], 'message');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1].peer, { type: 'private', userId: '456' });
  assert.equal(events[0][1].raw, raw);
  services.close();
  listener().onRecvMsg([raw]);
  assert.equal(events.length, 1);
});

test('group member query separates completed empty lists from native failure and partial lists', async () => {
  const member = { uin: '456', uid: 'u_member', nick: 'member', cardName: '', role: 2 };
  const complete = (infos: Map<string, unknown> = new Map()) => ({ errCode: 0, result: { infos, finish: true } });
  let response: unknown = complete();
  let calls = 0;
  const session = {
    getMsgService: () => ({ addKernelMsgListener() {} }),
    getBuddyService: () => ({ addKernelBuddyListener() {} }),
    getGroupService: () => ({ addKernelGroupListener() {}, getAllMemberList(groupId: string, refresh: boolean) {
      assert.deepEqual([groupId, refresh], ['123', false]); calls++; return response;
    } }),
  };
  const services = createNativeServices(session, '7.0.2-53644', () => {});
  try {
    assert.deepEqual(await services.invokeOperation('getGroupMembers', { groupId: '123' }), []);
    response = complete(new Map([['u_member', member]]));
    assert.deepEqual(await services.invokeOperation('getGroupMembers', { groupId: '123' }), [{ userId: '456', uid: 'u_member', nickname: 'member', card: '', role: 'member' }]);
    for (const [value, code] of [
      [{ errCode: 73, result: { infos: new Map(), finish: true } }, 73],
      [{ errCode: 'denied', credential: 'fixture-secret', result: { infos: new Map(), finish: true } }, 'denied'],
      [{ errCode: NaN, result: { infos: new Map(), finish: true } }, 'invalid-result'],
      [{ result: { infos: new Map(), finish: true } }, 'invalid-result'],
    ] as [unknown, string | number][]) {
      response = value;
      await assert.rejects(services.invokeOperation('getGroupMembers', { groupId: '123' }), error => {
        assert.equal((error as Error & { code: unknown }).code, code);
        assert.doesNotMatch(JSON.stringify(error), /fixture-secret|credential/);
        return true;
      });
    }
    for (const finish of [false, undefined, 1, 'true']) {
      response = { errCode: 0, result: { infos: new Map([['u_member', member]]), finish } };
      await assert.rejects(services.invokeOperation('getGroupMembers', { groupId: '123' }), /incomplete/);
    }
    response = { errCode: 0, result: { infos: [], finish: true } };
    await assert.rejects(services.invokeOperation('getGroupMembers', { groupId: '123' }), /member map/);
    assert.equal(calls, 11, 'one query per call, without automatic retries');
  } finally { services.close(); }
});

test('group metadata callbacks preserve query completion and stop after Session close', async () => {
  let listener: any;
  const events: [string, any][] = [];
  const session = {
    getMsgService: () => ({ addKernelMsgListener() {} }),
    getBuddyService: () => ({ addKernelBuddyListener() {} }),
    getGroupService: () => ({
      addKernelGroupListener(value: any) { if (!listener) listener = value; },
      getGroupList() {
        listener.onGroupListUpdate(2, [{ groupCode: '123', groupName: 'modified' }]);
        listener.onGroupListUpdate(1, [{ groupCode: '123', groupName: 'all', memberCount: 2, maxMember: 100 }]);
        return { result: 0 };
      },
    }),
  };
  const services = createNativeServices(session, '7.0.2-53644', (name, value) => events.push([name, value]));
  try {
    assert.deepEqual(await services.invokeOperation('listGroups'), [{ groupId: '123', name: 'all', memberCount: 2, maxMemberCount: 100 }]);
    listener.onMemberInfoChange('123', 1, new Map([['u', { uid: 'u', uin: '456', role: 3, isChangeRole: true }]]));
    assert.deepEqual(events.map(([name]) => name), ['group-list-updated', 'group-list-updated', 'group-members-updated']);
    assert.equal(events[0][1].kind, 'modified'); assert.equal(events[1][1].kind, 'all');
    assert.deepEqual(events[2][1], { groupId: '123', source: 'remote', members: [{ uid: 'u', userId: '456', role: 'admin', roleChanged: true }] });
    services.close();
    listener.onGroupListUpdate(3, [{ groupCode: '123' }]);
    listener.onMemberInfoChange('123', 0, new Map());
    assert.equal(events.length, 3);
  } finally { services.close(); }
});

test('nonlocal image input rejects without invoking native send', async () => {
  const { services, sentCalls } = fixture();
  try { await assert.rejects(services.invokeOperation('sendGroupMessage', { groupId: '123', message: [{ type: 'image', file: 'https://example.test/image.png' }] }), /absolute local file path/); assert.equal(sentCalls.length, 0); }
  finally { services.close(); }
});

test('receive replay is deduplicated per conversation without suppressing history or other peers', async () => {
 const {services,events,listener}=fixture();
 try {
  const raw={msgId:'42',msgSeq:'9',msgTime:'100',chatType:2,peerUid:'123',elements:[]};
  listener().onRecvMsg([raw,raw]);
  listener().onRecvMsg([{...raw}, {...raw,peerUid:'456'}, {...raw,chatType:1}]);
  assert.equal(events.filter(([event])=>event==='message').length,3);
  await services.invokeOperation('getHistory',{peer:{type:'group',groupId:'123'},options:{before:'42',limit:2}});
  listener().onMsgInfoListUpdate([{...raw,recallTime:'101'}]);
  assert.equal(events.filter(([event])=>event==='message-recalled').length,1);
 }finally{services.close();}
});

// A callback cannot override rejection of the native submission itself.
test('failed submission retains native code even when success callback arrives first', async () => {
  const {services,msg,listener,sentCalls}=fixture();
  msg.sendMsg=(...args:any[])=>{
    sentCalls.push(args);
    listener().onMsgInfoListUpdate([{guildId:'unique',sendStatus:2,msgId:'42',msgSeq:'9',msgTime:'100'}]);
    return Promise.resolve({result:23});
  };
  try {
    await assert.rejects(services.invokeOperation('sendGroupMessage',{groupId:'123',message:'fixture only'}),{message:/Native operation rejected/,code:23});
    assert.equal(sentCalls.length,1,'failed submissions are never retried');
  } finally {services.close();}
});

test('recall waits for the selected conversation as well as the message ID', async () => {
  const {services,msg,listener}=fixture();
  let settled=false,calls=0;
  (msg as any).recallMsg=(peer:any,ids:string[])=>{
    calls++;assert.deepEqual(peer,{chatType:2,peerUid:'123'});assert.deepEqual(ids,['42']);
    listener().onMsgInfoListUpdate([{msgId:'42',chatType:2,peerUid:'other',recallTime:'101'}]);
    listener().onMsgInfoListUpdate([{msgId:'42',chatType:1,peerUid:'123',recallTime:'101'}]);
    return {result:0};
  };
  try {
    const pending=services.invokeOperation('recallMessage',{peer:{type:'group',groupId:'123'},messageId:'42'}).then(()=>{settled=true;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false,'unrelated notifications do not confirm recall');
    listener().onMsgInfoListUpdate([{msgId:'42',chatType:2,peerUid:'123',recallTime:'101'}]);
    await pending;assert.equal(settled,true);assert.equal(calls,1);
  } finally {services.close();}
});

test('closing services during UID lookup prevents a deferred group mutation', async () => {
  let finishLookup:(value:any)=>void=()=>{},mutations=0,lookupStarted=false;
  const session={
    getMsgService:()=>({addKernelMsgListener(){}}),
    getBuddyService:()=>({addKernelBuddyListener(){}}),
    getGroupService:()=>({addKernelGroupListener(){},modifyMemberRole(){mutations++;return {result:0};}}),
    getUixConvertService:()=>({getUid(){lookupStarted=true;return new Promise(resolve=>{finishLookup=resolve;});}}),
  };
  const services=createNativeServices(session,'7.0.2-53644',()=>{});
  const pending=services.invokeOperation('setGroupAdmin',{groupId:'123',userId:'456',enabled:true});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(lookupStarted,true);
  services.close();finishLookup({uidInfo:new Map([['456','u_fixture']])});
  await assert.rejects(pending,/closed/);assert.equal(mutations,0);
});

test('close during local image preparation prevents native staging and send', async () => {
  const directory=await mkdtemp(join(tmpdir(),'qq-close-image-'));
  const {services,msg,sentCalls}=fixture();let staged=0;
  (msg as any).getRichMediaFilePathForGuild=()=>{staged++;return join(directory,'staged.png');};
  try {
    const file=join(directory,'input.png'),png=Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(1,16);png.writeUInt32BE(1,20);await writeFile(file,png);
    const pending=services.invokeOperation('sendGroupMessage',{groupId:'123',message:[{type:'image',file}]});
    services.close();
    await assert.rejects(pending,/closed/);assert.equal(staged,0);assert.equal(sentCalls.length,0);
  } finally {services.close();await rm(directory,{recursive:true,force:true});}
});

test('friend listing rejects incomplete profiles rather than returning partial success', async () => {
  const session={getMsgService:()=>({addKernelMsgListener(){}}),getGroupService:()=>({addKernelGroupListener(){}}),
    getBuddyService:()=>({addKernelBuddyListener(){},getBuddyListV2(){return {result:0,data:[{buddyUids:['u_a','u_b']}]};}}),
    getProfileService:()=>({getCoreAndBaseInfo(){return new Map([['u_a',{coreInfo:{uin:'456',nick:'fixture'}}]]);}})};
  const services=createNativeServices(session,'7.0.2-53644',()=>{});
  try {await assert.rejects(services.invokeOperation('listFriends'),/incomplete/);} finally {services.close();}
});

test('friend listing rejects native query errors before profiles and preserves successful empty lists', async () => {
  let response: unknown = { result: 73, data: [] }, queries = 0, profileReads = 0;
  const services = createNativeServices({
    getMsgService: () => ({ addKernelMsgListener() {} }),
    getGroupService: () => ({ addKernelGroupListener() {} }),
    getBuddyService: () => ({ addKernelBuddyListener() {}, getBuddyListV2(...args: unknown[]) {
      assert.deepEqual(args, ['0', true, 0]); queries++; return response;
    } }),
    getProfileService: () => ({ getCoreAndBaseInfo() { profileReads++; return new Map(); } }),
  }, '7.0.2-53644', () => {});
  try {
    for (const [value, code] of [
      [{ result: -1, data: [] }, -1], [{ result: 73, data: [] }, 73], [{ result: 'denied', data: [{ buddyUids: ['u_private'] }], errMsg: 'fixture-secret' }, 'denied'],
      [{ result: '0', data: [] }, '0'], [{ data: [] }, 'invalid-result'],
      [{ result: NaN, data: [] }, 'invalid-result'], [{ result: Infinity, data: [] }, 'invalid-result'],
    ] as [unknown, string | number][]) {
      response = value;
      await assert.rejects(services.invokeOperation('listFriends'), error => {
        assert.equal((error as any).code, code);
        assert.doesNotMatch((error as Error).message, /fixture-secret|u_private/);
        return true;
      });
    }
    assert.equal(profileReads, 0, 'a failed buddy query cannot initiate profile reads');
    assert.equal(queries, 7, 'one query per explicit request, with no retry');
    response = { result: 0, data: [] };
    assert.deepEqual(await services.invokeOperation('listFriends'), []);
    assert.equal(queries, 8);
  } finally { services.close(); }
});

test('malformed native batches do not terminate delivery of subsequent valid messages', () => {
  const {services,events,listener}=fixture();
  try {
    assert.doesNotThrow(()=>listener().onRecvMsg(null));
    assert.doesNotThrow(()=>listener().onRecvMsg([null,{chatType:1,elements:{secret:'fixture value'}}]));
    assert.doesNotThrow(()=>listener().onMsgInfoListUpdate(null));
    assert.doesNotThrow(()=>listener().onMsgInfoListUpdate([null]));
    listener().onRecvMsg([{msgId:'42',msgSeq:'1',msgTime:'100',chatType:2,peerUid:'123',elements:[]}]);
    assert.equal(events.filter(([name])=>name==='message').length,1);
    const diagnostics=events.filter(([name])=>name==='diagnostic');assert.equal(diagnostics.length,5);
    assert.ok(!JSON.stringify(diagnostics).includes('fixture value'),'diagnostics omit native payloads');
  } finally {services.close();}
});

test('group list queries coalesce and a timed-out uncorrelated callback cannot satisfy a later query', async () => {
  const listeners:any[]=[];let calls=0;
  const services=createNativeServices({
    getMsgService:()=>({addKernelMsgListener(){}}),
    getBuddyService:()=>({addKernelBuddyListener(){}}),
    getGroupService:()=>({addKernelGroupListener(value:any){listeners.push(value);return listeners.length;},getGroupList(){calls++;return {result:0};}}),
  },'3.2.32-52194',()=>{});
  try {
    const first=services.invokeOperation('listGroups');
    const second=services.invokeOperation('listGroups');
    assert.equal(calls,1);
    const outcomes=await Promise.allSettled([first,second]);
    assert.ok(outcomes.every(result=>result.status==='rejected'&&/timed out/.test(result.reason.message)));
    for(const listener of listeners)listener.onGroupListUpdate(1,[]);
    await assert.rejects(services.invokeOperation('listGroups'),/channel invalidated/);
    assert.equal(calls,1);
  } finally {services.close();}
});

test('native group query rejection overrides an early full-list callback and preserves its code', async () => {
  const listeners:any[]=[];
  const services=createNativeServices({
    getMsgService:()=>({addKernelMsgListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){}}),
    getGroupService:()=>({addKernelGroupListener(value:any){listeners.push(value);return listeners.length;},getGroupList(){for(const listener of listeners)listener.onGroupListUpdate(1,[]);return {result:73};}}),
  },'3.2.32-52194',()=>{});
  try {await assert.rejects(services.invokeOperation('listGroups'),error=>{assert.equal((error as any).code,73);return true;});}
  finally {services.close();}
});

test('forced group refresh accepts REFRESHALL zero while ignoring delta callbacks',async()=>{
  const listeners:any[]=[];
  const services=createNativeServices({getMsgService:()=>({addKernelMsgListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){}}),
    getGroupService:()=>({addKernelGroupListener(value:any){listeners.push(value);return listeners.length;},getGroupList(force:boolean){
      assert.equal(force,true);for(const listener of listeners){listener.onGroupListUpdate(2,[]);listener.onGroupListUpdate(3,[]);}
      for(const listener of listeners)listener.onGroupListUpdate(0,[{groupCode:'123',groupName:'refreshed',memberCount:2,maxMember:100}]);return {result:0};
    }})},'3.2.32-52194',()=>{});
  try {assert.deepEqual(await services.invokeOperation('listGroups'),[{groupId:'123',name:'refreshed',memberCount:2,maxMemberCount:100}]);}
  finally {services.close();}
});

test('native recall rejection overrides even an early matching completion without retry', async () => {
 const {services,msg,listener}=fixture();let calls=0;
 (msg as any).recallMsg=()=>{calls++;listener().onMsgInfoListUpdate([{msgId:'42',chatType:2,peerUid:'123',recallTime:'101'}]);return {result:8,credential:'private fixture'};};
 try{await assert.rejects(services.invokeOperation('recallMessage',{peer:{type:'group',groupId:'123'},messageId:'42'}),(error:any)=>{assert.equal(error.code,8);assert.equal(error.credential,undefined);return true;});assert.equal(calls,1);}finally{services.close();}
});

test('core service callback diagnostics contain shapes only and stop after close',()=>{
 let listener:any;const audits:unknown[]=[];
 const session={getMsgService:()=>({addKernelMsgListener(value:any){listener=value;}}),getBuddyService:()=>({addKernelBuddyListener(){}}),getGroupService:()=>({addKernelGroupListener(){}})};
 const services=createNativeServices(session,'7.0.2-53644',()=>{},undefined,undefined,undefined,undefined,info=>audits.push(info));
 listener.onRecvMsg([]);listener.onRichMediaUploadComplete({privatePayload:'credential'},null,[1]);
 assert.deepEqual(audits,[{family:'Msg',name:'onRecvMsg',argumentTypes:['array']},{family:'Msg',name:'onRichMediaUploadComplete',argumentTypes:['object','null','array']}]);
 assert.equal(JSON.stringify(audits).includes('credential'),false);services.close();listener.onRecvMsg([]);assert.equal(audits.length,2);
});
