import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createForwardMessages } from '../src/forward-messages.ts';
import type { Message, Peer } from '../src/types.ts';
const resolvePeer = async (peer: Peer) => peer.type === 'private' ? { chatType: 1 as const, peerUid: 'u_resolved' } : { chatType: 2 as const, peerUid: peer.groupId };

test('reads native merged-forward contents with exact root and parent IDs', async () => {
  const raw = { msgId: '99', chatType: 1, elements: [] };
  const decoded = { messageId: '99', raw } as Message;
  const operations = createForwardMessages({ getMsgService: () => ({ getMultiMsg: (peer: unknown, root: string, parent: string) => {
    assert.deepEqual(peer, { chatType: 1, peerUid: 'u_resolved' }); assert.equal(root, '10'); assert.equal(parent, '20');
    return { result: 0, msgList: [raw] };
  } }) }, resolvePeer, value => { assert.equal(value, raw); return decoded; });
  assert.deepEqual(await operations.invokeOperation('getForwardMessages', { peer: { type: 'private', userId: '123' }, rootMessageId: '10', parentMessageId: '20' }), [decoded]);
});

test('forwards existing messages with exact native destinations and empty Map', async () => {
  const calls: any[] = [];
  const operations = createForwardMessages({ getMsgService: () => ({ forwardMsg: (...args: unknown[]) => { calls.push(args); return { result: 0 }; } }) }, resolvePeer, () => undefined);
  assert.equal(calls.length, 0);
  const source = { type: 'group', groupId: '123' };
  const destination = { type: 'private', userId: '456' };
  assert.equal(await operations.invokeOperation('forwardMessages', { source, destination, messageIds: ['10', '20'] }), undefined);
  assert.deepEqual(calls[0], [['10', '20'], { chatType: 2, peerUid: '123' }, [{ chatType: 1, peerUid: 'u_resolved' }], new Map()]);
  assert.deepEqual(source, { type: 'group', groupId: '123' });
});

test('validates all inputs before UID lookup or native invocation', async () => {
  let invoked = 0;
  const operations = createForwardMessages({ getMsgService: () => { invoked++; return {}; } }, async peer => { invoked++; return resolvePeer(peer); }, () => undefined);
  const cases = [
    ['getForwardMessages', { peer: { type: 'group', groupId: '123' }, rootMessageId: '10' }],
    ['getForwardMessages', { peer: { type: 'private', userId: 'bad' }, rootMessageId: '10', parentMessageId: '20' }],
    ['forwardMessages', { source: { type: 'group', groupId: '123' }, destination: { type: 'group', groupId: '456' }, messageIds: [] }],
    ['forwardMessages', { source: { type: 'group', groupId: '123' }, destination: { type: 'group', groupId: '456' }, messageIds: ['10', null] }],
  ] as const;
  for (const [method, payload] of cases) await assert.rejects(operations.invokeOperation(method, payload));
  assert.equal(invoked, 0);
});

test('native errors, malformed lists, missing messages and undecodable content reject', async () => {
  for (const result of [undefined, { result: 5 }, { result: 0 }, { result: 0, msgList: [null] }, { result: 0, msgList: [{ chatType: 0 }] }]) {
    const operations = createForwardMessages({ getMsgService: () => ({ getMultiMsg: () => result }) }, resolvePeer, () => undefined);
    await assert.rejects(operations.invokeOperation('getForwardMessages', { peer: { type: 'group', groupId: '123' }, rootMessageId: '10', parentMessageId: '20' }));
  }
  const operations = createForwardMessages({ getMsgService: () => ({ forwardMsg: () => undefined }) }, resolvePeer, () => undefined);
  await assert.rejects(operations.invokeOperation('forwardMessages', { source: { type: 'group', groupId: '123' }, destination: { type: 'group', groupId: '456' }, messageIds: ['10'] }), /failed/);
});

test('sparse forward identifiers reject before any resolver or native call', async () => {
  let calls = 0;
  const operations = createForwardMessages({getMsgService(){calls++;return{forwardMsg(){calls++;return{result:0};}};}}, async p => {calls++;return resolvePeer(p);}, () => undefined);
  for (const messageIds of [Array(1), ['10', ...Array(1)]]) {
    await assert.rejects(operations.invokeOperation('forwardMessages', {source:{type:'group',groupId:'123'},destination:{type:'group',groupId:'456'},messageIds}));
  }
  assert.equal(calls,0);
});

for (const [label, invalid] of [
  ['sparse messages', Array(1)],
  ['numeric message ID', [{msgId:99,chatType:1,elements:[]}]],
  ['absent elements', [{msgId:'99',chatType:1}]],
  ['sparse elements', [{msgId:'99',chatType:1,elements:Array(1)}]],
  ['invalid element object', [{msgId:'99',chatType:1,elements:[[]]}]],
] as const) test(`merged-forward rejects ${label} without decoding a partial batch`, async () => {
  let decoded=0;
  const first={msgId:'10',chatType:2,elements:[]};
  const msgList=label==='sparse messages'?invalid:[first,...invalid];
  const operations=createForwardMessages({getMsgService:()=>({getMultiMsg:()=>({result:0,msgList})})},resolvePeer, raw=>{decoded++;return {messageId:String(raw.msgId)} as Message;});
  await assert.rejects(operations.invokeOperation('getForwardMessages',{peer:{type:'group',groupId:'123'},rootMessageId:'10',parentMessageId:'20'}));
  assert.equal(decoded,0);
});

test('merged-forward preserves empty success, mixed source conversations, order and long IDs', async () => {
  const messages=[{msgId:'900719925474099312345',chatType:2,elements:[]},{msgId:'2',chatType:1,elements:[{elementType:1}]}];
  for(const msgList of [[],messages]){
    const operations=createForwardMessages({getMsgService:()=>({getMultiMsg:()=>({result:0,msgList})})},resolvePeer,raw=>({messageId:raw.msgId} as Message));
    const result=await operations.invokeOperation('getForwardMessages',{peer:{type:'group',groupId:'123'},rootMessageId:'10',parentMessageId:'20'});
    assert.deepEqual((result as Message[]).map(message=>message.messageId),msgList.map(raw=>raw.msgId));
  }
});

for(const method of ['getForwardMessages','forwardMessages'] as const) test(`${method} does not return a late native result after shutdown`, async () => {
  const controller=new AbortController();let finish!: (value:unknown)=>void, started!:()=>void,calls=0;
  const began=new Promise<void>(resolve=>{started=resolve;}),delayed=new Promise(resolve=>{finish=resolve;});
  const native=()=>{calls++;started();return delayed;};
  const operations=createForwardMessages({getMsgService:()=>({getMultiMsg:native,forwardMsg:native})},resolvePeer,raw=>({messageId:raw.msgId} as Message),controller.signal);
  const payload=method==='getForwardMessages'?{peer:{type:'group',groupId:'123'},rootMessageId:'10',parentMessageId:'20'}:{source:{type:'group',groupId:'123'},destination:{type:'group',groupId:'456'},messageIds:['10']};
  const pending=operations.invokeOperation(method,payload);await began;controller.abort();finish({result:0,msgList:[]});
  await assert.rejects(pending,/abort/i);assert.equal(calls,1);
});

test('shutdown during source resolution prevents destination lookup and forward mutation', async () => {
  const controller=new AbortController();let finish!:(value:Awaited<ReturnType<typeof resolvePeer>>)=>void,started!:()=>void,resolutions=0,mutations=0;
  const began=new Promise<void>(resolve=>{started=resolve;}),delayed=new Promise<Awaited<ReturnType<typeof resolvePeer>>>(resolve=>{finish=resolve;});
  const operations=createForwardMessages({getMsgService:()=>({forwardMsg(){mutations++;return{result:0};}})},async()=>{resolutions++;started();return delayed;},()=>undefined,controller.signal);
  const pending=operations.invokeOperation('forwardMessages',{source:{type:'group',groupId:'123'},destination:{type:'group',groupId:'456'},messageIds:['10']});
  await began;controller.abort();finish({chatType:2,peerUid:'123'});
  await assert.rejects(pending,/abort/i);assert.equal(resolutions,1);assert.equal(mutations,0);
});
