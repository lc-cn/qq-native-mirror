import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QQClient, createClient, type LoginRequest } from '../src/index.ts';
import { createKernel } from '../src/kernel.ts';

class Worker extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  requests: any[] = [];
  send(value: any, callback: (error: Error | null) => void) {
    this.requests.push(value); callback(null);
    if (value.method === 'init') queueMicrotask(() => this.emit('message', { id: value.id, result: { exports: [] } }));
    if (value.method === 'close') queueMicrotask(() => this.emit('message', { id: value.id, result: null }));
  }
  kill() { this.connected = false; this.exitCode = 0; queueMicrotask(() => this.emit('exit', 0, null)); return true; }
}

const invalid = [null, {}, { method: 'typo' }, { method: 'quick' }, { method: 'quick', uin: 123 }, { method: 'restore', uin: '' }, { method: 'restore', uin: null }];

test('invalid JS login requests are rejected before IPC and leave the client usable', async () => {
  const worker = new Worker(), client = new QQClient(worker as unknown as ChildProcess, 30);
  try {
    for (const request of invalid) {
      await assert.rejects(Promise.resolve().then(() => client.login(request as LoginRequest)), /Invalid login/);
      assert.equal(client.state, 'idle');
      assert.equal(worker.requests.length, 0);
    }
    const login = client.login({ method: 'qr' });
    worker.emit('message', { id: worker.requests.at(-1).id, result: { uin: '123', uid: 'mock' } });
    assert.equal((await login).uin, '123');
  } finally { await client.close(); }
});

test('invalid reconnect cannot retire an existing online account', async () => {
  const worker = new Worker(); let spawns = 0;
  const client = new QQClient(worker as unknown as ChildProcess, 30, { method: 'qr' }, {
    spawn() { spawns++; return new Worker() as unknown as ChildProcess; }, payload: {},
  });
  try {
    worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'mock' } });
    await assert.rejects(client.reconnect({ method: 'quick' } as LoginRequest), /Invalid login/);
    assert.equal(worker.connected, true); assert.equal(spawns, 0);
    assert.equal(client.state, 'online'); assert.equal(client.account?.uin, '123');
  } finally { await client.close(); }
});

test('reconnect snapshots the requested account and rejects conflicting concurrent targets', async () => {
  const worker = new Worker(), replacement = new Worker();
  const client = new QQClient(worker as unknown as ChildProcess, 500, { method: 'qr' }, {
    spawn: () => replacement as unknown as ChildProcess, payload: {},
  });
  try {
    const request: LoginRequest = { method: 'restore', uin: '123' };
    const login = client.reconnect(request);
    request.uin = '456';
    const conflict = assert.rejects(client.reconnect(request), /different reconnect request/);
    assert.equal(client.reconnect({ method: 'restore', uin: '123' }), login);
    while (!replacement.requests.some(value => value.method === 'login')) await new Promise<void>(resolve => setImmediate(resolve));
    const sent = replacement.requests.find(value => value.method === 'login');
    assert.deepEqual(sent.login, { method: 'restore', uin: '123' });
    replacement.emit('message', { event: 'ready', payload: { uin: '123', uid: 'mock' } });
    replacement.emit('message', { id: sent.id, result: { uin: '123', uid: 'mock' } });
    await login; await conflict;
  } finally { await client.close(); }
});

test('factory validates configured login before reading native files', async () => {
  for (const request of invalid) await assert.rejects(createClient({
    dataDir: '/unused-account', wrapperPath: '/missing-login-request-fixture.node', login: request as LoginRequest,
  }), /Invalid login/);
});

test('factory owns configured login across preparation and deferred automatic login', () => {
  const source = new URL('../src/index.ts', import.meta.url).href;
  const nativePackage = new URL('../src/native-package.ts', import.meta.url).href;
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { EventEmitter } from 'node:events';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    let resume;
    const gate = new Promise(resolve => { resume = resolve; });
    class Worker extends EventEmitter {
      connected = true; exitCode = null; requests = [];
      send(value, callback) {
        this.requests.push(value); callback(null);
        if (value.method === 'init') queueMicrotask(() => this.emit('message', { id: value.id, result: { exports: [] } }));
        if (value.method === 'login') queueMicrotask(() => this.emit('message', { id: value.id, result: { uin: '123', uid: 'mock' } }));
        if (value.method === 'close') queueMicrotask(() => this.emit('message', { id: value.id, result: null }));
      }
      kill() { this.connected = false; this.exitCode = 0; queueMicrotask(() => this.emit('exit', 0, null)); return true; }
    }
    const worker = new Worker();
    mock.module(${JSON.stringify(nativePackage)}, { namedExports: { prepareNative: async () => { await gate; return { wrapperPath: '/mock/native.node' }; } } });
    mock.module('node:child_process', { namedExports: { fork: () => worker } });
    const { createClient } = await import(${JSON.stringify(source)});
    const root = await mkdtemp(join(tmpdir(), 'qq-factory-login-'));
    let client;
    try {
      const request = { method: 'quick', uin: '123' };
      const options = { dataDir: root, login: request };
      const creating = createClient(options);
      request.uin = '456'; options.login = { method: 'quick', uin: '789' };
      resume(); client = await creating;
      options.login = { method: 'quick', uin: '999' };
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(worker.requests.find(value => value.method === 'login').login, { method: 'quick', uin: '123' });
      assert.equal((await client.waitForLogin()).uin, '123');
    } finally { await client?.close(); await rm(root, { recursive: true, force: true }); }
  `], { timeout: 5000, stdio: 'pipe' });
});

test('kernel rejects malformed IPC login before preparing or connecting native services', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-login-validation-'));
  const events: string[] = [];
  const kernel = createKernel({}, { dataDir: root, version: { clientVersion: 'test', appId: 'test', qua: 'test' } }, event => events.push(event));
  try {
    for (const request of invalid) await assert.rejects(kernel.login(request as LoginRequest), /Invalid login/);
    assert.deepEqual(events, []);
  } finally { await kernel.close(); await rm(root, { recursive: true, force: true }); }
});

test('kernel keeps its QR request when the caller mutates the object during preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-login-snapshot-'));
  const calls: unknown[] = []; let listener: any;
  const kernel = createKernel({
    NodeIQQNTWrapperEngine: { get: () => ({ initWithDeskTopConfig() {} }) },
    NodeIKernelLoginService: { get: () => ({
      initConfig() {}, addKernelLoginListener(value: any) { listener = value; },
      connect() { listener.onLoginConnected(); }, getMsfStatus: () => 0,
      getQRCodePicture() { calls.push('qr'); return false; },
      quickLoginWithUin(uin: unknown) { calls.push(uin); return { result: 'mock-error' }; },
    }) },
    NodeIQQNTWrapperSession: { create: () => ({}) },
  }, { dataDir: root, version: { clientVersion: 'test', appId: 'test', qua: 'test' }, loginTimeoutMs: 100 }, () => {});
  try {
    const request: any = { method: 'qr' };
    const login = kernel.login(request);
    request.method = 'quick'; request.uin = '456';
    await assert.rejects(login, /rejected QR request/);
    assert.deepEqual(calls, ['qr']);
  } finally { await kernel.close(); await rm(root, { recursive: true, force: true }); }
});
