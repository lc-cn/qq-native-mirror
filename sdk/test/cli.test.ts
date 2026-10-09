import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, prepareCommand, normalizeMessage, observeWatchFailures } from '../src/cli.ts';
import type { QQClient } from '../src/index.ts';

test('face JSON validates before client creation and preserves mixed message order', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-cli-face-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'faces.json');
  const message = [{ type: 'text', text: 'hello' }, { type: 'face', id: 0 }, { type: 'face', id: 333 }];
  await writeFile(file, JSON.stringify(message));
  const action = await prepareCommand('send', { kind: 'group', target: '123', 'message-file': file });
  let sent: unknown;
  await action({ sendGroupMessage: async (...args: unknown[]) => { sent = args; } } as unknown as QQClient);
  assert.deepEqual(sent, ['123', message]);
  for (const id of [undefined, null, '14', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 99999]) {
    assert.throws(() => normalizeMessage([{ type: 'face', id }]), /Face id|Unsupported QQ face/);
  }
  await writeFile(file, '[{"type":"face","id":99999}]');
  const config = join(dir, 'qq.json');
  await writeFile(config, JSON.stringify({ dataDir: join(dir, 'unused-account'), wrapperPath: join(dir, 'absent-wrapper.node'), version: { clientVersion: '7.0.2-53644', appId: 'fixture', qua: 'fixture' } }));
  const invalid = spawnSync(process.execPath, ['src/cli.ts', 'send', '--config', config, '--kind', 'group', '--target', '123', '--message-file', file], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unsupported QQ face id/);
  assert.doesNotMatch(invalid.stderr, /ENOENT/);
});

test('nickname CLI only dispatches an explicitly supplied nonblank name', async () => {
  const calls:string[]=[];
  const action=await prepareCommand('nickname',{name:'新昵称 ✓'});
  assert.deepEqual(calls,[]);
  await action({setNickname:async(name:string)=>{calls.push(name);}} as unknown as QQClient);
  assert.deepEqual(calls,['新昵称 ✓']);
  await assert.rejects(prepareCommand('nickname',{name:' '}),/blank/);
});

test('group notice CLI validates explicit mutations and preserves notice identifiers', async () => {
  const calls: unknown[]=[];
  const client=new Proxy({}, {get:(_,method)=>async(...args:unknown[])=>{calls.push([method,...args]);}}) as QQClient;
  await (await prepareCommand('group-notice-publish',{'group-id':'123',text:'公告 ✓',pinned:'true',image:'./picture.png'}))(client);
  await (await prepareCommand('group-notice-delete',{'group-id':'123','notice-id':'notice_42'}))(client);
  assert.deepEqual(calls,[['publishGroupNotice','123','公告 ✓',{pinned:true,confirmRequired:false,imagePath:resolve('picture.png')}],['deleteGroupNotice','123','notice_42']]);
  for(const flags of [{'group-id':'123',text:' '},{'group-id':'bad',text:'ok'},{'group-id':'123',text:'ok',pinned:'yes'}]) await assert.rejects(prepareCommand('group-notice-publish',flags));
  assert.equal(calls.length,2,'invalid preparations never dispatch');
});

test('group notice list CLI prepares a read for an explicit group only', async () => {
  const calls:unknown[]=[];
  const action=await prepareCommand('group-notices',{'group-id':'123'});
  assert.deepEqual(calls,[]);
  await action({listGroupNotices:async(groupId:string)=>{calls.push(groupId);return {notices:[],raw:{ec:0,feeds:[]}};}} as unknown as QQClient);
  assert.deepEqual(calls,['123']);
  await assert.rejects(prepareCommand('group-notices',{'group-id':'bad'}),/numeric/);
});

test('message inputs validate typed elements and resolve local media paths', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'message.json');
  await writeFile(file, JSON.stringify([{ type: 'text', text: 'hello' }, { type: 'at', userId: 'all' }, { type: 'image', file: './image.png' }, { type: 'reply', messageId: '3' }, { type: 'file', file: './file.txt', name: 'file.txt' }]));
  let called: unknown[] | undefined;
  const action = await prepareCommand('send', { kind: 'private', target: '123', 'message-file': file });
  assert.equal(called, undefined, 'preparation never dispatches');
  await action({ sendPrivateMessage: async (...args: unknown[]) => { called = args; } } as QQClient);
  assert.deepEqual(called, ['123', normalizeMessage(JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8')))]);
  assert.equal((called![1] as any[])[2].file, resolve('image.png'));
  for (const value of [[], {}, '', [{ type: 'unknown' }], [{ type: 'at', userId: 'bad' }], [{ type: 'image', file: 3 }]]) assert.throws(() => normalizeMessage(value));
  await assert.rejects(prepareCommand('send', { kind: 'group', target: '123', text: 'hello', 'message-file': file }), /exactly one/);
});

test('CLI mutation commands validate before dispatch and allow explicit empty card/remark', async () => {
  assert.equal(parse(['member-card', '--card', '']).flags.card, '');
  const calls: unknown[] = [];
  const client = new Proxy({}, { get: (_, method) => async (...args: unknown[]) => { calls.push([method, ...args]); } }) as QQClient;
  await (await prepareCommand('member-card', { 'group-id': '123', 'user-id': '456', card: '' }))(client);
  await (await prepareCommand('friend-remark', { target: '456', remark: '' }))(client);
  await (await prepareCommand('request', { uid: 'u_req', time: '123', accept: 'false' }))(client);
  assert.deepEqual(calls, [['setGroupMemberCard', '123', '456', ''], ['setFriendRemark', '456', ''], ['handleFriendRequest', { uid: 'u_req', time: '123' }, false]]);
  for (const [command, flags] of [['history', { kind: 'group', target: '123', limit: '101' }], ['member-admin', { 'group-id': '123', 'user-id': '456', enabled: 'yes' }], ['member-mute', { 'group-id': '123', 'user-id': '456', seconds: '-1' }], ['request', { uid: 'u', time: 'bad', accept: 'true' }]] as [string, Record<string, string>][]) await assert.rejects(prepareCommand(command, flags));
  assert.equal(calls.length, 3);
});

test('CLI subprocess help and invalid mutation arguments never need account configuration', () => {
  const help = spawnSync(process.execPath, ['src/cli.ts', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /message-file/); assert.match(help.stdout, /group-leave/);
  const invalid = spawnSync(process.execPath, ['src/cli.ts', 'send', '--unexpected', 'x'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Unknown option/);
});

test('group request CLI separates list and explicit decisions and rejects unknown types', async () => {
 const calls: unknown[]=[];
 const client={listGroupRequests:async (options:unknown)=>calls.push(options),handleGroupRequest:async (...args:unknown[])=>calls.push(args)} as unknown as QQClient;
 const list=await prepareCommand('group-requests',{limit:'10',before:'42',doubt:'true'});
 assert.deepEqual(calls,[]);
 await list(client);
 assert.deepEqual(calls[0],{limit:10,before:'42',doubt:true});
 const decide=await prepareCommand('group-request',{'group-id':'123',sequence:'42',type:'7',accept:'false',reason:'decline'});
 await decide(client);
 assert.deepEqual(calls[1],[{groupId:'123',sequence:'42',type:7,doubt:false},false,'decline']);
 await assert.rejects(prepareCommand('group-request',{'group-id':'123',sequence:'42',type:'2',accept:'true'}),/type/);
 await assert.rejects(prepareCommand('group-requests',{limit:'0'}),/limit/);
 assert.equal(calls.length,2);
});

test('forward CLI preserves exact source, destination and message identifiers before dispatch', async () => {
 const calls:unknown[]=[];
 const client={forwardMessages:async(...args:unknown[])=>calls.push(args),getForwardMessages:async(...args:unknown[])=>calls.push(args)} as unknown as QQClient;
 const send=await prepareCommand('forward',{'source-kind':'private','source-target':'123',kind:'group',target:'456','message-ids':'42,43'});
 assert.equal(calls.length,0);
 await send(client);
 assert.deepEqual(calls[0],[{type:'private',userId:'123'},{type:'group',groupId:'456'},['42','43']]);
 const read=await prepareCommand('forward-history',{kind:'group',target:'456','root-message-id':'42','parent-message-id':'41'});
 await read(client);
 assert.deepEqual(calls[1],[{type:'group',groupId:'456'},'42','41']);
 await assert.rejects(prepareCommand('forward',{'source-kind':'private','source-target':'123',kind:'group',target:'456','message-ids':'42,'}),/message-ids/);
});

test('watch stops on terminal account failures and only waits for enabled transport reconnect', () => {
  const events=new EventEmitter(),errors:Error[]=[];
  const remove=observeWatchFailures(events as QQClient,true,error=>errors.push(error));
  events.emit('disconnected',{retryable:true});assert.equal(errors.length,0);
  events.emit('disconnected',{retryable:false});events.emit('kicked',{});events.emit('logout');
  const reconnectError=new Error('restore failed');events.emit('reconnect-error',reconnectError);
  assert.equal(errors.length,4);assert.equal(errors[3],reconnectError);
  remove();for(const name of ['disconnected','kicked','logout','terminated','reconnect-error']) assert.equal(events.listenerCount(name),0);
  const removeDisabled=observeWatchFailures(events as QQClient,false,error=>errors.push(error));
  events.emit('disconnected',{retryable:true});assert.equal(errors.length,5);removeDisabled();
});

test('CLI init supports default catalog, acceleration and local manifest metadata without native loading', async t => {
 const dir=await mkdtemp(join(tmpdir(),'qq-cli-default-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const config=join(dir,'qq.json');
 const run=(args:string[])=>spawnSync(process.execPath,['src/cli.ts',...args],{encoding:'utf8'});
 const init=run(['init','--config',config,'--data-dir',join(dir,'account'),'--download-mirror','https://gh-proxy.com/']);
 assert.equal(init.status,0,init.stderr);
 const checked=run(['config','--config',config]);assert.equal(checked.status,0,checked.stderr);
 const options=JSON.parse(checked.stdout);assert.equal(options.wrapperPath,undefined);assert.equal(options.version,undefined);assert.deepEqual(options.downloadMirrors,['https://gh-proxy.com/']);
 assert.equal(run(['init','--config',config,'--data-dir',join(dir,'other')]).status,1,'init must preserve existing config');
 assert.deepEqual(JSON.parse(run(['config','--config',config]).stdout),options);
 const local=run(['init','--config',join(dir,'local.json'),'--data-dir',join(dir,'local-account'),'--wrapper',join(dir,'not-loaded.node')]);assert.equal(local.status,0,local.stderr);
 const partial=run(['init','--config',join(dir,'bad.json'),'--data-dir',dir,'--client-version','1']);assert.equal(partial.status,1);assert.match(partial.stderr,/app-id/);
 const badProxy=run(['init','--config',join(dir,'unsafe.json'),'--data-dir',dir,'--download-mirror','http://unsafe.example/']);assert.equal(badProxy.status,1);assert.match(badProxy.stderr,/HTTPS/);
});
