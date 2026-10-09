import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Owned fixtures only; no QQ loading, login, transport, or attachment query.
export async function verifyReceivedForwardConsumer(packagePath) {
 const load=name=>import(pathToFileURL(join(packagePath,'dist',name)).href);
 const {createNativeServices}=await load('native-services.js');
 const {buildMergedForwardCard}=await load('merged-forward-card.js');
 await checkReceivedForwardServices({createNativeServices,buildMergedForwardCard});
 return{receivedForwardContract:true,nativeReceivedForwardObserved:false};
}
export async function checkReceivedForwardServices({createNativeServices,buildMergedForwardCard}) {
 const flush=async()=>{for(let i=0;i<5;i++)await new Promise(done=>setImmediate(done));};
 const card=()=>buildMergedForwardCard({resourceId:'r',cardId:'00000000-0000-4000-8000-000000000000',nodes:[{displayName:'fixture',text:'text'}]});
 const native16=()=>({elementType:16,multiForwardMsgElement:{resId:'native-r',fileName:'native-file',xmlContent:'<opaque-fixture />'}});
 const elements=()=>[{elementType:1,textElement:{content:'before',atType:0}},card(),native16(),{elementType:10,arkElement:{bytesData:'{"app":"unrelated"}'}},{elementType:1,textElement:{content:'after',atType:0}}];
 const raw=(id='1',missing=false)=>({msgId:id,msgSeq:'9',msgTime:'100',chatType:2,peerUid:'123',senderUin:missing?'0':'456',senderUid:'u_sender',elements:elements()});
 function fixture(records=[],resolver=()=>({uinInfo:new Map([['u_sender','456']])})){
  let listener;const calls=[],events=[],lookups=[];
  const services=createNativeServices({getMsgService:()=>({addKernelMsgListener(value){listener=value;},
   getMsgsByMsgId(...args){calls.push(['getMessage',args]);return{result:0,msgList:records};},
   getMsgsIncludeSelf(...args){calls.push(['getHistory',args]);return{result:0,msgList:records};},
   getMultiMsg(...args){calls.push(['getForwardMessages',args]);return{result:0,msgList:records};}}),
   getGroupService:()=>({addKernelGroupListener(){}}),getBuddyService:()=>({addKernelBuddyListener(){}}),
   getUixConvertService:()=>({getUin(ids){lookups.push(ids);return resolver(ids);},getUid(){throw Error('Unexpected recipient query');}}),
  },'7.0.2-53644',(event,value)=>events.push([event,value]));
  return{services,calls,events,lookups,listener:()=>listener};
 }
 const payload={peer:{type:'group',groupId:'123'},messageId:'1',rootMessageId:'10',parentMessageId:'20',options:{limit:3}};
 function check(message,original){
  assert.equal(message.raw,original);assert.deepEqual(message.elements.map(e=>e.type),['text','forward','forward','unknown','text']);
  assert.equal(message.elements[0].text,'before');assert.equal(message.elements[4].text,'after');
  assert.deepEqual(message.elements[1],{type:'forward',format:'ark',resourceId:'r',cardId:'00000000-0000-4000-8000-000000000000',title:'聊天记录',summary:'查看1条消息',prompt:'[聊天记录]',count:1,previews:['fixture:text']});assert.deepEqual(message.elements[2],{type:'forward',format:'native',resourceId:'native-r',cardId:'native-file'});
  assert.equal(message.elements[3].data,original.elements[3]);
 }
 for(const method of ['getMessage','getHistory','getForwardMessages']){
  const original=raw(),f=fixture([original]);
  try{const value=await f.services.invokeOperation(method,payload);check(Array.isArray(value)?value[0]:value,original);assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],method);assert.equal(f.lookups.length,0);}
  finally{f.services.close();}
 }
 const live=fixture();try{const original=raw();live.listener().onRecvMsg([original]);await flush();const delivered=live.events.filter(([event])=>event==='message');assert.equal(delivered.length,1);check(delivered[0][1],original);assert.equal(live.calls.length,0);assert.equal(live.lookups.length,0);}finally{live.services.close();}
 const invalidRaw=raw('4');invalidRaw.elements=[{elementType:10,arkElement:{bytesData:'{'}},{elementType:16,multiForwardMsgElement:{resId:'x',fileName:'file'}},{elementType:10,arkElement:{bytesData:'{"app":"com.tencent.multimsg","meta":{"detail":{"resid":0}}}'}}];
 const invalid=fixture([invalidRaw]);try{const message=await invalid.services.invokeOperation('getMessage',{...payload,messageId:'4'});assert.deepEqual(message.elements.map(e=>e.type),['unknown','unknown','unknown']);for(let i=0;i<3;i++)assert.equal(message.elements[i].data,invalidRaw.elements[i]);assert.equal(invalid.calls.length,1);assert.equal(invalid.lookups.length,0);}finally{invalid.services.close();}
 let accessorReads=0,coercions=0;
 const getter=()=>{accessorReads++;return card().arkElement.bytesData;};
 const unsafe=raw('5');unsafe.elements=[
  {elementType:10,arkElement:Object.defineProperty({},'bytesData',{get:getter,enumerable:true})},
  Object.defineProperty({elementType:10},'arkElement',{get(){accessorReads++;return card().arkElement;},enumerable:true}),
  Object.defineProperty({},'elementType',{get(){accessorReads++;return 10;},enumerable:true}),
  {elementType:{valueOf(){coercions++;return 10;}},arkElement:card().arkElement},
  {elementType:16,multiForwardMsgElement:Object.defineProperty({fileName:'f',xmlContent:''},'resId',{get(){accessorReads++;return 'r';},enumerable:true})},
 ];
 for(const method of ['getMessage','getHistory','getForwardMessages']){
  const f=fixture([unsafe]);try{const value=await f.services.invokeOperation(method,{...payload,messageId:'5'});const message=Array.isArray(value)?value[0]:value;assert.deepEqual(message.elements.map(e=>e.type),Array(5).fill('unknown'));for(let i=0;i<5;i++)assert.equal(message.elements[i].data,unsafe.elements[i]);assert.equal(accessorReads,0);assert.equal(coercions,0);assert.equal(f.lookups.length,0);}finally{f.services.close();}
 }
 const unsafeLive=fixture();try{unsafeLive.listener().onRecvMsg([unsafe]);await flush();const messages=unsafeLive.events.filter(([event])=>event==='message');assert.equal(messages.length,1);assert.deepEqual(messages[0][1].elements.map(e=>e.type),Array(5).fill('unknown'));assert.equal(accessorReads,0);assert.equal(coercions,0);}finally{unsafeLive.services.close();}
 let finish;const pending=new Promise(resolve=>{finish=resolve;});const queued=fixture([],()=>pending);
 try{
  const first=raw('2',true),second=raw('3');queued.listener().onRecvMsg([first]);await flush();queued.listener().onRecvMsg([second]);
  first.elements[1].arkElement.bytesData='{}';first.elements[2].multiForwardMsgElement.resId='mutated';first.elements[2].multiForwardMsgElement.fileName='mutated';
  second.elements[1].arkElement.bytesData='{}';second.elements[2].multiForwardMsgElement.resId='mutated';second.elements[2].multiForwardMsgElement.fileName='mutated';
  finish({uinInfo:new Map([['u_sender','456']])});await flush();
  const messages=queued.events.filter(([event])=>event==='message').map(([,message])=>message);assert.equal(messages.length,2);
  assert.deepEqual(messages.map(message=>message.messageId),['2','3']);
  for(const message of messages){assert.deepEqual(message.elements[1],{type:'forward',format:'ark',resourceId:'r',cardId:'00000000-0000-4000-8000-000000000000',title:'聊天记录',summary:'查看1条消息',prompt:'[聊天记录]',count:1,previews:['fixture:text']});assert.deepEqual(message.elements[2],{type:'forward',format:'native',resourceId:'native-r',cardId:'native-file'});}
  assert.equal(messages[0].raw,first);assert.equal(messages[1].raw,second);assert.equal(queued.calls.length,0);assert.equal(queued.lookups.length,1);
 }finally{queued.services.close();}
}
