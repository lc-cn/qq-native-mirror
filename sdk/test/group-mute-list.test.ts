import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectGroupMuteList } from '../src/group-mute-list.ts';
import { createNativeServices } from '../src/native-services.ts';
const member = {uid:'u_member',uin:'900719925474099312345',nick:'昵称',cardName:'',role:2,shutUpTime:1734567890};
const projected = {uid:member.uid,userId:member.uin,nickname:member.nick,card:'',role:'member',shutUpTime:member.shutUpTime};
function fixture(invoke:(groupId:string)=>unknown=()=>({result:0})) {
 const listeners:any[]=[],calls:string[]=[];
 const services=createNativeServices({getMsgService:()=>({addKernelMsgListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){}}),
  getGroupService:()=>({addKernelGroupListener(listener:any){listeners.push(listener);},getGroupShutUpMemberList(id:string){calls.push(id);return invoke(id);}})
 },'7.0.2-53644',()=>{});
 return {services,calls,notify(id:string,value:unknown){for(const listener of listeners)listener.onShutUpMemberListChanged(id,value);}};
}
test('mute list preserves exact identities, all native role states and opaque time without native-field leakage',()=>{
 const source={...member,phoneNum:'fixture-secret'};
 const result=projectGroupMuteList([source]);assert.deepEqual(result,[projected]);result[0].nickname='modified';assert.equal(source.nick,member.nick);
 assert.deepEqual(projectGroupMuteList([]),[]);
 for(const [role,name] of ['unspecified','stranger','member','admin','owner'].entries())assert.equal(projectGroupMuteList([{...member,role}])[0].role,name);
});
test('invalid/sparse/partial mute lists reject atomically and never execute accessors',()=>{
 let reads=0;
 for(const value of [null,{},Array(1),[member,null],[{...member,uin:123}],[{...member,uid:''}],[{...member,role:5}],[{...member,shutUpTime:-1}],[{...member,shutUpTime:1.5}],[{...member,shutUpTime:Number.MAX_SAFE_INTEGER+1}],[{...member,get nick(){reads++;return 'invalid';}}]])assert.throws(()=>projectGroupMuteList(value),/Invalid native group mute/);
 assert.equal(reads,0);
});
test('matching mute callback and successful return are both required, same-ID reads coalesce into fresh DTOs',async()=>{
 let finish!:(value:unknown)=>void;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
 try{
  let done=false;const a=f.services.invokeOperation('listGroupMutedMembers',{groupId:'000123'}).then(value=>{done=true;return value as any[];});
  const b=f.services.invokeOperation('listGroupMutedMembers',{groupId:'000123'}) as Promise<any[]>;
  f.notify('other',[member]);f.notify('000123',[member]);await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);assert.deepEqual(f.calls,['000123']);
  finish({result:0});const av=await a,bv=await b;assert.deepEqual(av,[projected]);assert.deepEqual(bv,[projected]);assert.notEqual(av,bv);assert.notEqual(av[0],bv[0]);av[0].nickname='mutated';assert.equal(bv[0].nickname,member.nick);
 }finally{f.services.close();}
});
test('mute-list errors are preserved, never converted to empty success, and quarantine only failed group channel',async()=>{
 const f=fixture(()=>({result:73,errMsg:'denied'}));
 try{
  const pending=f.services.invokeOperation('listGroupMutedMembers',{groupId:'123'});f.notify('123',[]);await assert.rejects(pending,error=>(error as any).code===73);
  f.notify('123',[member]);await assert.rejects(f.services.invokeOperation('listGroupMutedMembers',{groupId:'123'}),/channel is invalid/);assert.equal(f.calls.length,1);
  await assert.rejects(f.services.invokeOperation('listGroupMutedMembers',{groupId:'456'}),error=>(error as any).code===73);assert.deepEqual(f.calls,['123','456']);
 }finally{f.services.close();}
 const malformed=fixture();try{const p=malformed.services.invokeOperation('listGroupMutedMembers',{groupId:'123'});malformed.notify('123',[member,null]);await assert.rejects(p,/Invalid native/);}finally{malformed.services.close();}
});
test('mute-list timeout/close interrupt native promise and callbacks; invalid IDs never dispatch',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture(()=>new Promise(()=>{}));try{
  for(const groupId of [undefined,123,'0','bad',{}])await assert.rejects(f.services.invokeOperation('listGroupMutedMembers',{groupId}));assert.equal(f.calls.length,0);
  const stopped=assert.rejects(f.services.invokeOperation('listGroupMutedMembers',{groupId:'123'}),/timed out/);t.mock.timers.tick(5000);await stopped;
  await assert.rejects(f.services.invokeOperation('listGroupMutedMembers',{groupId:'123'}),/channel is invalid/);
  const closed=assert.rejects(f.services.invokeOperation('listGroupMutedMembers',{groupId:'456'}),/closed|abort/i);f.services.close();await closed;f.notify('456',[member]);
 }finally{f.services.close();}
 const empty=fixture();try{const pending=empty.services.invokeOperation('listGroupMutedMembers',{groupId:'123'});empty.notify('123',[]);assert.deepEqual(await pending,[]);}finally{empty.services.close();}
});


test('native Msg callback projects mute/admin events without identity queries and stops after close',()=>{
 let msg:any;const events:[string,any][]=[];
 const services=createNativeServices({getMsgService:()=>({addKernelMsgListener(value:any){msg=value;}}),getBuddyService:()=>({addKernelBuddyListener(){}}),getGroupService:()=>({addKernelGroupListener(){}}),getUixConvertService:()=>{throw Error('unexpected identity query');}},'7.0.2-53644',(name,value)=>events.push([name,value]));
 const raw={msgId:'1',msgSeq:'2',msgTime:'100',chatType:2,msgType:5,peerUid:'123',senderUin:'456',senderUid:'u_sender',sendNickName:'fixture',elements:[{grayTipElement:{subElementType:4,groupElement:{type:8,shutUp:{duration:'0',admin:{uid:'u_admin'},member:{uid:''}}}}}]};
 msg.onRecvMsg([raw]);assert.deepEqual(events.filter(([name])=>name==='group-mute'),[['group-mute',{groupId:'123',scope:'all',durationSeconds:'0',enabled:false,operatorUid:'u_admin'}]]);
 msg.onRecvSysMsg([18,2,8,44,26,11,18,9,8,123,34,5,18,3,10,1,117]);assert.deepEqual(events.filter(([name])=>name==='group-admin'),[['group-admin',{groupId:'123',memberUid:'u',enabled:true}]]);
 services.close();const count=events.length;msg.onRecvMsg([raw]);msg.onRecvSysMsg([]);assert.equal(events.length,count);
});
