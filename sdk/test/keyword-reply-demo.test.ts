import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  runDemo,
  loadDemoConfig,
  saveDemoAccount,
  type DemoConfig,
  type DemoDependencies,
} from '../examples/keyword-reply.ts';
import type {
  ClientEvents,
  ClientState,
  Account,
  MessageElement,
  MessageEvent,
  MessageInput,
} from '../src/types.ts';
import { createMessageEvent } from '../src/client/message-event.ts';
import type { OperationCall, OperationResult } from '../src/runtime/operation-contracts.ts';
const account: Account = { uin: '123', uid: 'self' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
class Client extends EventEmitter<ClientEvents> {
  state: ClientState = 'idle';
  closes = 0;
  logins = 0;
  sends: { destination: string; input: MessageInput }[] = [];
  loginResult = deferred<Account>();
  sendFailure = false;
  closeFailure = false;
  login() {
    this.logins++;
    return this.loginResult.promise;
  }
  async close() {
    this.closes++;
    this.state = 'closed';
    if (this.closeFailure) throw new Error('close failure');
  }
  async listFriends() {
    return [];
  }
  async listGroups() {
    return [];
  }
  async sendPrivateMessage(destination: string, input: MessageInput) {
    this.sends.push({ destination, input });
    if (this.sendFailure) throw Error('send failure');
    return { messageId: '99', sequence: '1', time: 1 };
  }
  async sendGroupMessage(destination: string, input: MessageInput) {
    return this.sendPrivateMessage(destination, input);
  }
}
const config: DemoConfig = {
  client: { dataDir: '/isolated-demo' },
  login: { method: 'qr' },
  keyword: 'ping',
  reply: 'pong',
  privateMessages: true,
  groupMessages: true,
  userIds: [],
  groupIds: [],
  openQr: false,
  loadContacts: false,
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function message(
  id: string,
  client: Client,
  group = false,
  elements: MessageElement[] = [{ type: 'text', text: ' ping ' }],
): MessageEvent {
  const event = createMessageEvent(
    {
      messageId:
        (
          {
            self: '10',
            old: '11',
            keyword: '12',
            denied: '13',
            good: '14',
            cooldown: '15',
            next: '16',
            offline: '17',
          } as Record<string, string>
        )[id] ?? id,
      sequence: '1',
      time: 100,
      peer: group
        ? { type: 'group', groupId: '456' }
        : { type: 'private', userId: id === 'denied' ? '999' : '789' },
      sender: { userId: '789', uid: 'other', nickname: 'fixture' },
      elements,
      raw: null,
    },
    {
      assertActive() {
        if (client.state !== 'online') throw Error('offline');
      },
      invoke<C extends OperationCall>(...command: C): Promise<OperationResult<C[0]>> {
        const [operation, payload] = command;
        if (operation === 'sendPrivateMessage')
          return client.sendPrivateMessage(payload.userId, payload.message) as Promise<
            OperationResult<C[0]>
          >;
        if (operation === 'sendGroupMessage')
          return client.sendGroupMessage(payload.groupId, payload.message) as Promise<
            OperationResult<C[0]>
          >;
        assert.fail(`Unexpected demo operation: ${operation}`);
      },
    },
  );
  assert.ok(event);
  return event;
}
function harness(client = new Client(), cfg = config) {
  const controller = new AbortController();
  let now = 100000;
  const logs: string[] = [];
  const saved: Account[] = [];
  const deps: DemoDependencies = {
    createClient: async () => client,
    saveAccount: async (value) => {
      saved.push({ ...value });
    },
    showQr: async () => {},
    removeQr: async () => {},
    log: (value) => logs.push(value),
    now: () => now,
  };
  const run = runDemo(cfg, controller.signal, deps);
  void run.catch(() => {});
  return {
    client,
    controller,
    run,
    logs,
    saved,
    setTime(value: number) {
      now = value;
    },
  };
}
test('authenticated is not ready; private and group messages receive original-ID quoted replies', async () => {
  const h = harness();
  await tick();
  h.client.emit('authenticated', account);
  h.client.emit('message', message('1', h.client));
  assert.equal(h.client.sends.length, 0);
  h.client.state = 'online';
  h.client.emit('ready', account);
  h.client.loginResult.resolve(account);
  await tick();
  assert.deepEqual(h.saved, [account]);
  h.client.emit('message', message('002', h.client));
  h.client.emit('message', message('003', h.client, true));
  await tick();
  assert.equal(h.client.sends.length, 2);
  for (const [index, id] of ['002', '003'].entries()) {
    const input = h.client.sends[index].input;
    assert.ok(Array.isArray(input));
    assert.equal(input.length, 2);
    assert.deepEqual(input[0], { type: 'reply', messageId: id });
    const text = input[1];
    assert.equal(text.type, 'text');
    if (text.type !== 'text') throw new Error('Expected text reply');
    assert.deepEqual(Object.keys(text).sort(), ['text', 'type']);
    assert.match(text.text, /^pong\n当前内存使用量：\d+\.\d{2} MB$/);
  }
  h.controller.abort();
  await h.run;
  assert.equal(h.client.closes, 1);
});
test('self history duplicate keyword cooldown whitelist and offline suppress sends', async () => {
  const h = harness(new Client(), { ...config, userIds: ['789'], groupIds: ['456'] });
  await tick();
  h.client.state = 'online';
  h.client.emit('ready', account);
  h.client.loginResult.resolve(account);
  await tick();
  const self = message('self', h.client);
  self.sender.uid = 'self';
  h.client.emit('message', self);
  const old = message('old', h.client);
  old.time = 1;
  h.client.emit('message', old);
  const keyword = message('keyword', h.client, false, [{ type: 'text', text: 'ping!' }]);
  h.client.emit('message', keyword);
  const denied = message('denied', h.client);
  h.client.emit('message', denied);
  h.client.emit('message', message('good', h.client));
  h.client.emit('message', message('good', h.client));
  h.client.emit('message', message('cooldown', h.client));
  assert.equal(h.client.sends.length, 1);
  h.setTime(104000);
  h.client.emit('message', message('next', h.client));
  assert.equal(h.client.sends.length, 2);
  h.client.emit('offline', { source: 'login', kind: 'unknown', retryable: false, args: [] });
  h.client.emit('message', message('offline', h.client, true));
  assert.equal(h.client.sends.length, 2);
  h.controller.abort();
  await h.run;
});
test('duplicate readiness preserves reply deduplication, cooldown and the original online log', async (t) => {
  const h = harness();
  t.after(async () => {
    h.controller.abort();
    await h.run;
  });
  await tick();
  h.client.state = 'online';
  h.client.emit('ready', account);
  h.client.loginResult.resolve(account);
  await tick();
  h.client.emit('message', message('201', h.client));
  assert.equal(h.client.sends.length, 1);

  h.setTime(100001);
  h.client.emit('ready', { ...account });
  h.client.emit('message', message('201', h.client));
  h.client.emit('message', message('202', h.client));
  assert.equal(h.client.sends.length, 1, 'readiness cannot reset the current cooldown');

  h.setTime(103000);
  h.client.emit('ready', { ...account });
  h.client.emit('message', message('201', h.client));
  assert.equal(h.client.sends.length, 1, 'an older ID remains seen after cooldown expires');
  h.client.emit('message', message('203', h.client));
  assert.equal(h.client.sends.length, 2, 'a new message is eligible after the original cooldown');
  assert.equal(h.logs.filter((line) => line.startsWith('已上线：')).length, 1);
});
test('keyword matching uses captured event text without rereading mutable elements', async (t) => {
  const h = harness();
  t.after(async () => {
    h.controller.abort();
    await h.run;
  });
  await tick();
  h.client.state = 'online';
  h.client.emit('ready', account);
  h.client.loginResult.resolve(account);
  await tick();
  const accepted = message('204', h.client);
  Object.defineProperty(accepted, 'elements', {
    get: () => assert.fail('reply policy must use the captured text'),
  });
  h.client.emit('message', accepted);
  assert.equal(h.client.sends.length, 1);
  h.setTime(103000);
  const rejected = message('205', h.client, false, [{ type: 'text', text: 'ping!' }]);
  rejected.elements = [{ type: 'text', text: 'ping' }];
  h.client.emit('message', rejected);
  assert.equal(h.client.sends.length, 1, 'mutable elements cannot change the captured keyword');
});
test('same-account restoration after offline starts a new reply window and logs once', async (t) => {
  const h = harness();
  t.after(async () => {
    h.controller.abort();
    await h.run;
  });
  await tick();
  h.client.state = 'online';
  h.client.emit('ready', account);
  h.client.loginResult.resolve(account);
  await tick();
  h.client.emit('message', message('201', h.client));
  assert.equal(h.client.sends.length, 1);
  h.client.state = 'disconnected';
  const offline = { source: 'login', kind: 'transport', retryable: false, args: [] } as const;
  h.client.emit('offline', { ...offline, args: [] });
  h.client.emit('disconnected', { ...offline, args: [] });
  h.client.emit('message', message('202', h.client));
  assert.equal(h.client.sends.length, 1);

  h.setTime(100001);
  h.client.state = 'online';
  h.client.emit('ready', { ...account });
  h.client.emit('ready', { ...account });
  h.client.emit('message', message('201', h.client));
  assert.equal(h.client.sends.length, 2, 'same identity has a fresh window after real retirement');
  assert.equal(h.logs.filter((line) => line.startsWith('已上线：')).length, 2);
  assert.equal(h.logs.filter((line) => line.startsWith('账号已离线')).length, 1);
});
test('a changed UIN or UID starts a new reply window without merging distinct identities', async (t) => {
  const h = harness();
  t.after(async () => {
    h.controller.abort();
    await h.run;
  });
  await tick();
  h.client.state = 'online';
  h.client.emit('ready', account);
  h.client.loginResult.resolve(account);
  await tick();
  h.client.emit('message', message('201', h.client));
  for (const identity of [
    { ...account, uin: '0123' },
    { uin: '0123', uid: 'other_self' },
  ]) {
    h.client.emit('ready', identity);
    h.client.emit('message', message('201', h.client));
  }
  assert.equal(h.client.sends.length, 3);
  assert.equal(h.logs.filter((line) => line.startsWith('已上线：')).length, 3);
});
test('abort while factory loads closes late client once without login', async () => {
  const client = new Client(),
    pending = deferred<Client>(),
    controller = new AbortController();
  const run = runDemo(config, controller.signal, {
    createClient: () => pending.promise,
    saveAccount: async () => {},
    showQr: async () => {},
    removeQr: async () => {},
    log: () => {},
    now: () => 100000,
  });
  controller.abort();
  pending.resolve(client);
  await run;
  assert.equal(client.closes, 1);
  assert.equal(client.logins, 0);
});
test('send and close failures remain single attempts', async () => {
  const client = new Client();
  client.sendFailure = true;
  client.closeFailure = true;
  const h = harness(client);
  await tick();
  client.state = 'online';
  client.emit('ready', account);
  client.loginResult.resolve(account);
  await tick();
  client.emit('message', message('1', h.client));
  await tick();
  h.controller.abort();
  await assert.rejects(
    h.run,
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some(
        (item: unknown) => item instanceof Error && item.message === 'close failure',
      ),
  );
  assert.equal(client.sends.length, 1);
  assert.equal(client.closes, 1);
});
test('terminated retires demo and closes client once', async () => {
  const h = harness();
  await tick();
  h.client.state = 'online';
  h.client.emit('ready', account);
  h.client.loginResult.resolve(account);
  await tick();
  h.client.emit('terminated', new Error('terminated'));
  await assert.rejects(h.run, /terminated/);
  assert.equal(h.client.closes, 1);
});
test('configuration paths are relative to file and login ownership is explicit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-demo-config-'));
  try {
    const file = join(dir, 'demo.json');
    await writeFile(
      file,
      JSON.stringify({
        client: { dataDir: 'account', wrapperPath: 'wrapper.node' },
        openQr: false,
      }),
    );
    const loaded = await loadDemoConfig(file);
    assert.equal(loaded.client.dataDir, join(dir, 'account'));
    assert.equal(loaded.client.wrapperPath, join(dir, 'wrapper.node'));
    assert.equal(loaded.client.autoReconnect, false);
    assert.deepEqual(loaded.login, { method: 'qr' });
    for (const raw of [
      { client: { login: { method: 'qr' } } },
      { client: { autoReconnect: true } },
      { login: { method: 'quick' } },
      { login: { method: 'password' } },
    ]) {
      await writeFile(file, JSON.stringify(raw));
      await assert.rejects(loadDemoConfig(file));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('login failure and cleanup failure retain primary and cause', async () => {
  const primary = new Error('login primary');
  const client = new Client();
  client.closeFailure = true;
  client.login = () => Promise.reject(primary);
  const h = harness(client);
  await assert.rejects(
    h.run,
    (error: unknown) =>
      error instanceof AggregateError &&
      error.cause === primary &&
      error.errors[0] === primary &&
      error.errors.length === 2,
  );
  assert.equal(client.closes, 1);
});
test('QR presentation receives the owning abort signal', async () => {
  const client = new Client(),
    controller = new AbortController();
  let captured: AbortSignal | undefined;
  const run = runDemo(config, controller.signal, {
    createClient: async () => client,
    saveAccount: async () => {},
    showQr: async (_image, _path, _open, signal) => {
      captured = signal;
    },
    removeQr: async () => {},
    log: () => {},
    now: () => 100000,
  });
  await tick();
  client.emit('qrcode', { image: Buffer.from('fixture'), url: 'unused' });
  await tick();
  assert.equal(captured, controller.signal);
  client.state = 'online';
  client.emit('ready', account);
  client.loginResult.resolve(account);
  await tick();
  controller.abort();
  await run;
  assert.equal(captured.aborted, true);
});

test('saved account selects restore next launch, QR overrides and malformed marker never falls back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-demo-restore-'));
  try {
    const file = join(dir, 'config.json');
    await writeFile(file, JSON.stringify({ client: { dataDir: 'account' } }));
    assert.deepEqual((await loadDemoConfig(file)).login, { method: 'qr' });
    await saveDemoAccount(account, join(dir, 'account'));
    const marker = join(dir, 'account', 'demo-session.json');
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
      schemaVersion: 1,
      uin: account.uin,
    });
    if (process.platform !== 'win32') assert.equal((await stat(marker)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(dir, 'account')), ['demo-session.json']);
    const restored = await loadDemoConfig(file);
    assert.deepEqual(restored.login, { method: 'restore', uin: account.uin });
    assert.equal(restored.client.rememberPassword, true);
    assert.deepEqual((await loadDemoConfig(file, true)).login, { method: 'qr' });
    await writeFile(
      file,
      JSON.stringify({
        client: { dataDir: 'account', rememberPassword: false },
        login: { method: 'qr' },
      }),
    );
    assert.deepEqual((await loadDemoConfig(file)).login, { method: 'qr' });
    assert.equal((await loadDemoConfig(file)).client.rememberPassword, false);
    await writeFile(marker, JSON.stringify({ schemaVersion: 2, uin: '123' }));
    await writeFile(file, JSON.stringify({ client: { dataDir: 'account' } }));
    await assert.rejects(loadDemoConfig(file), /标记无效/);
    assert.deepEqual((await loadDemoConfig(file, true)).login, { method: 'qr' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('restore rejection never retries QR or saves an account', async () => {
  const failure = new Error('restore failed');
  const client = new Client();
  client.login = () => {
    client.logins++;
    return Promise.reject(failure);
  };
  const h = harness(client, { ...config, login: { method: 'restore', uin: '123' } });
  await assert.rejects(h.run, (error) => error === failure);
  assert.equal(client.logins, 1);
  assert.equal(client.closes, 1);
  assert.deepEqual(h.saved, []);
});
