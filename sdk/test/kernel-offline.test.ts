import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKernel } from '../src/kernel.ts';

async function fixture(initialStatuses: number[][] = [], complete = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'qq-offline-'));
  let loginListener: any, depends: any, sessionListener: any, messageListener: any, dispatcher: any, global: any;
  const events: Array<[string, any]> = [];
  const session = {
    init(_config: any, adapter: any, dispatch: any, listener: any) { depends = adapter; dispatcher = dispatch; sessionListener = listener; },
    getMsgService: () => ({ addKernelMsgListener(listener: any) { messageListener = listener; } }),
    getGroupService: () => ({ addKernelGroupListener() {} }),
    getBuddyService: () => ({ addKernelBuddyListener() { return 1; } }),
  };
  const service = {
    initConfig() {}, addKernelLoginListener(listener: any) { loginListener = listener; },
    connect() { loginListener.onLoginConnected(); }, getMsfStatus: () => 0,
    getQRCodePicture() { loginListener.onQRCodeLoginSucceed({ uid: 'u_a', uin: '123' }); return true; },
    getMachineGuid: () => '0123456789abcdef0123456789abcdef',
  };
  const kernel = createKernel({
    NodeIQQNTWrapperEngine: { get: () => ({ initWithDeskTopConfig(_config: any, adapter: any) { global = adapter; } }) },
    NodeIKernelLoginService: { get: () => service },
    NodeIQQNTStartupSessionWrapper: { create: () => ({ start() {
      for (const [status,reason] of initialStatuses) depends.onMSFStatusChange(status,reason);
      if (complete) sessionListener.onOpentelemetryInit({ is_init: true });
    } }) },
    NodeIQQNTWrapperSession: { getNTWrapperSession: () => session },
  }, { dataDir, loginTimeoutMs:100, version: { clientVersion: '7.0.2-53644', appId: '1', qua: 'test' } }, (event, value) => events.push([event, value]));
  try { await kernel.login({ method: 'qr' }); }
  catch(error) { await kernel.close();await rm(dataDir,{recursive:true});throw error; }
  return { kernel, events, login: () => loginListener, depends: () => depends, msg: () => messageListener, dispatcher: () => dispatcher, global: () => global,
    async close() { await kernel.close(); await rm(dataDir, { recursive: true }); } };
}

test('initial disconnected unknown snapshot does not abort native Session readiness', async () => {
  const f=await fixture([[1,0],[2,1]]);
  try {
    assert.equal(f.events.filter(([event])=>event==='ready').length,1);
    assert.equal(f.events.filter(([event])=>event==='offline').length,0);
    assert.ok(f.events.some(([event,value])=>event==='diagnostic'&&value.stage==='session-initial-msf-disconnected'));
    f.depends().onMSFStatusChange(1,0);
    assert.equal(f.events.filter(([event])=>event==='offline').length,1);
    await assert.rejects(f.kernel.invokeOperation('listFriends'),/not online/);
  } finally {await f.close();}
});

test('initial unknown snapshot without readiness still times out; established disconnect and logout still fail', async () => {
  await assert.rejects(fixture([[1,0]],false),/Login timed out/);
  await assert.rejects(fixture([[2,1],[1,0]],false),/became offline/);
  await assert.rejects(fixture([[1,2]],false),/became offline/);
});

test('forced offline retains all native kick fields and later disconnect remains forced', async () => {
  const f = await fixture();
  try {
    const info = { kickedType: 987, securityKickedType: 654, tipsDesc: 'native reason', sameDevice: true };
    f.msg().onKickedOffLine(info, { additional: true });
    const kicked = f.events.find(([event]) => event === 'kicked')?.[1];
    assert.equal(kicked.kind, 'forced'); assert.equal(kicked.retryable, false);
    assert.equal(kicked.kickedInfo, info); assert.deepEqual(kicked.args, [info, { additional: true }]);
    f.login().onLoginDisConnected('opaque reason', 432);
    assert.equal(f.events.filter(([event]) => event === 'offline').at(-1)?.[1].kind, 'forced');
    await assert.rejects(f.kernel.invokeOperation('listFriends'), /not online/);
  } finally { await f.close(); }
});

test('transport auto status does not imply safe reconnect and preserves native reason', async () => {
  const f = await fixture();
  try {
    f.depends().onMSFStatusChange(1, 3);
    const offline = f.events.find(([event]) => event === 'offline')?.[1];
    assert.equal(offline.kind, 'transport'); assert.equal(offline.retryable, false);
    assert.equal(offline.status, 1); assert.equal(offline.reason, 3);
    await assert.rejects(f.kernel.invokeOperation('listFriends'), /not online/);
  } finally { await f.close(); }
});

test('unknown login disconnect and SSO codes retain evidence without detecting meaning', async () => {
  const f = await fixture();
  try {
    f.depends().onMSFSsoError(987654, 'native description', { opaque: true });
    const error = f.events.find(([event]) => event === 'msf-error')?.[1];
    assert.equal(error.code, 987654); assert.equal(error.description, 'native description');
    assert.deepEqual(error.args, [987654, 'native description', { opaque: true }]);
    assert.equal(f.events.find(([event]) => event === 'offline')?.[1].kind, 'unknown');
    f.login().onLoginDisConnected({ unmapped: true });
    assert.deepEqual(f.events.filter(([event]) => event === 'offline').at(-1)?.[1].args, [{ unmapped: true }]);
  } finally { await f.close(); }
});

test('host callback audit records only method names and argument types', async () => {
  const f = await fixture();
  try {
    const sensitive = { token: 'never serialize this' };
    assert.equal(f.dispatcher().dispatchRequest(sensitive, 'secret string'), undefined);
    assert.equal(f.global().futureHostMethod(sensitive), undefined);
    const audits = f.events.filter(([event]) => event === 'native-callback').map(([, value]) => value);
    assert.deepEqual(audits.at(-2), { family: 'Dispatcher', name: 'dispatchRequest', argumentTypes: ['object', 'string'] });
    assert.deepEqual(audits.at(-1), { family: 'Global', name: 'futureHostMethod', argumentTypes: ['object'] });
    assert.equal(JSON.stringify(audits).includes('never serialize'), false);
  } finally { await f.close(); }
});
