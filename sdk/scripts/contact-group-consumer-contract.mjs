import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Actual worker IPC with only the kernel and dlopen replaced by local fixtures. */
export async function verifyContactGroupWorkerRoutes({ QQClient, workerPath, kernelPath }) {
  workerPath = await realpath(workerPath);
  kernelPath = await realpath(kernelPath);
  const directory = await mkdtemp(join(tmpdir(), 'qq-contact-routes-'));
  const hook = join(directory, 'fixture-hook.mjs');
  await writeFile(hook, `import {registerHooks} from 'node:module';
process.dlopen = () => {};
registerHooks({load(url,context,next){
 if(url!==${JSON.stringify(pathToFileURL(kernelPath).href)})return next(url,context);
 return {format:'module',shortCircuit:true,source:\`export function createKernel(_native,_options,emit){return {
  async prepare(){},async close(){},async login(){const account={uin:'123',uid:'u_fixture'};emit('ready',account);return account;},
  async invokeOperation(method,payload){if(method==='listFriendCategories')return [{categoryId:1,sortId:0,name:'fixture',memberCount:0,onlineCount:0,friends:[]}];
   if(method==='setGroupRemark')return {method,groupId:payload.groupId,remark:payload.remark};throw Error('Unexpected fixture operation');}
 };}\`};
}});
`);
  const worker = fork(workerPath, [], { cwd: directory, execArgv: ['--import', hook], serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  // Drain child output without forwarding fixture paths into consumer output.
  worker.stdout.resume(); worker.stderr.resume();
  const client = new QQClient(worker, 5000);
  try {
    await client.request('init', { options: { dataDir: join(directory, 'account'), wrapperPath: join(directory, 'fixture.node'), version: 'fixture', preloadLibraries: [] } });
    await client.login({ method: 'restore', uin: '123' });
    assert.deepEqual(await client.listFriendCategories(), [{ categoryId: 1, sortId: 0, name: 'fixture', memberCount: 0, onlineCount: 0, friends: [] }]);
    assert.deepEqual(await client.setGroupRemark('000123', ''), { method: 'setGroupRemark', groupId: '000123', remark: '' });
  } finally {
    try { await client.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
  return { contactGroupActualWorkerRoutes: true, kernelReplacedByFixture: true, nativeExecuted: false, accountUsed: false };
}

export async function verifyContactGroupConsumer(packageRoot) {
  const load = file => import(pathToFileURL(join(packageRoot, 'dist', file)).href);
  const { QQClient } = await load('index.js');
  const { prepareCommand, observeWatchEvents } = await load('cli.js');
  const { createGroupEvents } = await load('group-events.js');
  const { EventEmitter } = await import('node:events');
  const calls = [];
  await (await prepareCommand('friend-categories', {}))({ listFriendCategories: async () => { calls.push('categories'); return []; } });
  await (await prepareCommand('group-remark', { 'group-id': '123', remark: '' }))({ setGroupRemark: async (...args) => calls.push(args) });
  assert.deepEqual(calls, ['categories', ['123', '']]);
  const events = new EventEmitter(), lines = [];
  const stop = observeWatchEvents(events, 'normalized', line => lines.push(JSON.parse(line)));
  const listener = createGroupEvents((name, payload) => events.emit(name, payload));
  listener.onGroupDetailInfoChange({ groupCode: '123', groupName: '', memberNum: 0, maxMemberNum: 200, ownerUid: 'u_owner', ownerUin: '456', fingerMemo: '' });
  assert.equal(lines.length, 1); assert.equal(lines[0].event, 'group-info-updated');
  stop(); assert.equal(events.listenerCount('group-info-updated'), 0);
  return verifyContactGroupWorkerRoutes({ QQClient, workerPath: join(packageRoot, 'dist/worker.js'), kernelPath: join(packageRoot, 'dist/kernel.js') });
}
