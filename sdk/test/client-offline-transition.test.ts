import assert from 'node:assert/strict';
import { ChildProcess, fork, type Serializable } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { QQClient } from '../src/index.ts';
import type { Account, ClientState, OfflineInfo } from '../src/types.ts';

const account: Account = { uin: '123', uid: 'u_self' };
const transport: OfflineInfo = { source: 'login', kind: 'transport', retryable: true, args: [] };
const forced: OfflineInfo = { source: 'kicked', kind: 'forced', retryable: false, args: [] };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Manual login responses keep companion notifications inside the admitted
 * request, so a second retirement would observably reject that exact Promise.
 */
class Worker extends ChildProcess {
  readonly requests: Record<string, unknown>[] = [];
  constructor() {
    super();
    Object.defineProperty(this, 'connected', { value: true, configurable: true });
  }
  override send(value: Serializable, ...args: unknown[]): boolean {
    assert.ok(value && typeof value === 'object');
    const request = value as Record<string, unknown>;
    this.requests.push(request);
    const callback = args.find((argument) => typeof argument === 'function');
    if (typeof callback === 'function') Reflect.apply(callback, undefined, [null]);
    if (request.method === 'init' || request.method === 'close')
      queueMicrotask(() => {
        this.emit('message', {
          id: request.id,
          result: request.method === 'init' ? { exports: [] } : null,
        });
        if (request.method === 'close') this.kill();
      });
    return true;
  }
  override kill(): boolean {
    Object.defineProperty(this, 'connected', { value: false, configurable: true });
    Object.defineProperty(this, 'exitCode', { value: 0, configurable: true });
    this.emit('exit', 0, null);
    return true;
  }
  ready(): void {
    this.emit('message', { event: 'ready', payload: { ...account } });
  }
  completeLogin(): void {
    const request = this.requests.findLast((request) => request.method === 'login');
    assert.ok(request);
    this.ready();
    this.emit('message', { id: request.id, result: { ...account } });
  }
  offline(event: 'offline' | 'disconnected' | 'kicked', id: unknown, payload = transport): void {
    this.emit('message', { event, offlineTransition: id, payload: structuredClone(payload) });
  }
}

for (const reason of [transport, forced]) {
  test(`offline ${reason.kind} listener reconnect survives companions and resets transition numbering per worker`, async () => {
    const old = new Worker(),
      next = new Worker();
    const client = new QQClient(old, 500, undefined, { spawn: () => next, payload: {} });
    let reconnect: Promise<Account> | undefined;
    const states: ClientState[] = [];
    try {
      old.ready();
      client.on('state', (state) => states.push(state));
      client.once('offline', () => {
        assert.equal(client.state, 'disconnected');
        assert.equal(client.account, undefined);
        reconnect = client.reconnect();
      });
      old.offline('offline', 100, reason);
      old.offline('disconnected', 100, reason);
      old.offline('kicked', 100, reason);
      old.offline('offline', 100, reason);
      assert.deepEqual(states, ['disconnected', 'connecting']);
      assert.ok(reconnect);
      await tick();
      assert.deepEqual(
        next.requests.find((request) => request.method === 'login')?.login,
        reason.kind === 'forced' ? { method: 'restore' } : { method: 'restore', uin: account.uin },
      );
      next.completeLogin();
      await reconnect;
      old.offline('offline', 101, reason);
      assert.equal(client.state, 'online');
      next.offline('offline', 1, reason);
      assert.equal(client.state, 'disconnected');
      assert.equal(client.account, undefined);
    } finally {
      await client.close();
    }
  });
}

test('nested newer transition retires once and older companions cannot retire its listener login', async () => {
  const worker = new Worker(),
    client = new QQClient(worker, 500);
  let login: Promise<Account> | undefined;
  let notifications = 0;
  try {
    worker.ready();
    client.on('offline', () => {
      if (++notifications === 1) worker.offline('offline', 2);
      else login = client.login({ method: 'quick', uin: account.uin });
    });
    worker.offline('offline', 1);
    assert.ok(login);
    worker.offline('disconnected', 1);
    worker.offline('offline', 1);
    worker.offline('offline', 2);
    worker.offline('disconnected', 2);
    assert.equal(notifications, 2);
    worker.completeLogin();
    await login;
    worker.offline('disconnected', 1);
    worker.offline('offline', 2);
    assert.equal(client.state, 'online');
    client.removeAllListeners('offline');
    worker.offline('offline', 3);
    assert.equal(client.state, 'disconnected');
  } finally {
    await client.close();
  }
});

for (const action of ['close', 'newer-offline'] as const) {
  test(`state observer ${action} suppresses the superseded outer offline notification`, async () => {
    const worker = new Worker(),
      client = new QQClient(worker, 500);
    let close: Promise<void> | undefined;
    const sources: unknown[] = [];
    try {
      worker.ready();
      client.on('offline', (info) => sources.push(info.args[0]));
      client.once('state', () => {
        if (action === 'close') close = client.close();
        else worker.offline('offline', 2, { ...transport, args: ['newer'] });
      });
      worker.offline('offline', 1, { ...transport, args: ['older'] });
      assert.deepEqual(sources, action === 'close' ? [] : ['newer']);
      await close;
    } finally {
      await client.close();
    }
  });
}

test('offline close listener cannot be undone by companion notifications', async () => {
  const worker = new Worker(),
    client = new QQClient(worker, 500);
  let close: Promise<void> | undefined;
  let companions = 0;
  try {
    worker.ready();
    client.once('offline', () => {
      close = client.close();
    });
    client.on('disconnected', () => companions++);
    client.on('kicked', () => companions++);
    worker.offline('offline', 1, forced);
    worker.offline('disconnected', 1, forced);
    worker.offline('kicked', 1, forced);
    assert.ok(close);
    await close;
    assert.equal(client.state, 'closed');
    assert.equal(companions, 0);
  } finally {
    await client.close();
  }
});

for (const observer of ['state', 'offline'] as const) {
  test(`throwing ${observer} observer preserves retirement and same-transition deduplication`, async () => {
    const worker = new Worker(),
      client = new QQClient(worker, 500);
    const error = { observer };
    try {
      worker.ready();
      if (observer === 'state')
        client.once('state', () => {
          throw error;
        });
      else
        client.once('offline', () => {
          throw error;
        });
      assert.throws(
        () => worker.offline('offline', 1),
        (failure) => failure === error,
      );
      assert.equal(client.state, 'disconnected');
      assert.equal(client.account, undefined);
      const login = client.login({ method: 'quick', uin: account.uin });
      worker.offline('offline', 1);
      worker.offline('disconnected', 1);
      worker.completeLogin();
      await login;
    } finally {
      await client.close();
    }
  });
}

test('invalid transition metadata has no authority to deduplicate independent offline events', async () => {
  const worker = new Worker(),
    client = new QQClient(worker, 500);
  try {
    for (const id of [undefined, 0, -1, 1.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) {
      worker.ready();
      worker.offline('offline', id);
      const rejection = assert.rejects(
        client.login({ method: 'quick', uin: account.uin }),
        /became offline/,
      );
      worker.offline('disconnected', id);
      await rejection;
      assert.equal(client.state, 'disconnected');
    }
    worker.ready();
    const envelope = Object.defineProperty(
      { event: 'offline', payload: transport },
      'offlineTransition',
      {
        get: () => assert.fail('metadata accessor must not execute'),
      },
    );
    worker.emit('message', envelope);
    assert.equal(client.state, 'disconnected');
  } finally {
    await client.close();
  }
});

test('retryable companions arrange only one automatic restore and preserve the captured policy', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const old = new Worker(),
    next = new Worker();
  let spawns = 0;
  const client = new QQClient(
    old,
    500,
    undefined,
    {
      spawn: () => {
        spawns++;
        return next;
      },
      payload: {},
    },
    { delayMs: 10 },
  );
  try {
    old.ready();
    old.offline('offline', 1);
    context.mock.timers.tick(10);
    await tick();
    assert.equal(spawns, 0, 'automatic restore waits for disconnected presentation');
    old.offline('disconnected', 1, { ...transport, retryable: false });
    old.offline('disconnected', 1);
    old.offline('offline', 1);
    context.mock.timers.tick(10);
    await tick();
    assert.equal(spawns, 1, 'first notification owns the immutable retry policy');
    next.completeLogin();
    await client.waitForLogin();
    old.offline('disconnected', 1);
    assert.equal(client.state, 'online');
  } finally {
    await client.close();
  }
});

/** Uses the actual kernel, bootstrap and worker entry in a child process. Only
 * proprietary addon acquisition is replaced by an in-memory native service.
 */
test('kernel offline and forced notifications retain one private transition through actual worker IPC', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'qq-offline-ipc-')));
  const hook = join(directory, 'native-fixture.mjs');
  const inspection = new URL('../src/native/native-contract-inspection.ts', import.meta.url).href;
  let worker: ChildProcess | undefined;
  let client: QQClient | undefined;
  try {
    await writeFile(
      hook,
      `
import { registerHooks } from 'node:module';
let loginListener, sessionListener, messageListener;
const account={uin:'123',uid:'u_self'};
const service={initConfig(){},addKernelLoginListener(value){loginListener=value},connect(){loginListener.onLoginConnected()},getMsfStatus(){return 0},getQRCodePicture(){loginListener.onQRCodeLoginSucceed(account);return true},getMachineGuid(){return '0123456789abcdef0123456789abcdef'}};
const session={init(_config,_depends,_dispatch,listener){sessionListener=listener},getMsgService(){return {addKernelMsgListener(listener){messageListener=listener}}},getGroupService(){return {addKernelGroupListener(){}}},getBuddyService(){return {addKernelBuddyListener(){return 1}}}};
process.dlopen=target=>{target.exports={NodeIQQNTWrapperEngine:{get(){return {initWithDeskTopConfig(){}}}},NodeIKernelLoginService:{get(){return service}},NodeIQQNTStartupSessionWrapper:{create(){return {start(){sessionListener.onOpentelemetryInit({is_init:true})}}}},NodeIQQNTWrapperSession:{getNTWrapperSession(){return session}}}};
registerHooks({load(url,context,next){if(url===${JSON.stringify(inspection)})return {format:'module',source:'export async function inspectNativeContracts(){return undefined}',shortCircuit:true};return next(url,context)}});
process.on('message',message=>{if(message.control==='fixture-offline')loginListener.onLoginDisConnected('fixture');if(message.control==='fixture-kicked')messageListener.onKickedOffLine({kickedType:9})});
`,
    );
    worker = fork(new URL('../src/worker.ts', import.meta.url), [], {
      cwd: directory,
      execArgv: ['--import', pathToFileURL(hook).href],
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    worker.stdout?.resume();
    worker.stderr?.resume();
    const envelopes: Array<{
      event: string;
      offlineTransition: number;
      payload: Record<string, unknown>;
    }> = [];
    worker.on('message', (message: any) => {
      if (['offline', 'disconnected', 'kicked'].includes(message.event)) envelopes.push(message);
    });
    client = new QQClient(worker, 3000);
    const active = client;
    await client.request('init', {
      options: {
        dataDir: join(directory, 'data'),
        wrapperPath: join(directory, 'fixture.node'),
        preloadLibraries: [],
        version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' },
      },
    });
    await client.login({ method: 'qr' });
    for (const reason of ['offline', 'kicked'] as const) {
      const before = envelopes.length;
      const restored = new Promise<Account>((resolve, reject) => {
        active.once('offline', () => {
          assert.equal(active.state, 'disconnected');
          assert.equal(active.account, undefined);
          active.login({ method: 'qr' }).then(resolve, reject);
        });
      });
      worker.send({ control: `fixture-${reason}` });
      await restored;
      assert.equal(active.state, 'online');
      const notifications = envelopes.slice(before);
      assert.deepEqual(
        notifications.map((item) => item.event),
        reason === 'offline' ? ['offline', 'disconnected'] : ['offline', 'disconnected', 'kicked'],
      );
      assert.deepEqual(
        notifications.map((item) => item.offlineTransition),
        Array(notifications.length).fill(reason === 'offline' ? 1 : 2),
      );
      for (const item of notifications) {
        assert.equal(Object.hasOwn(item.payload, 'offlineTransition'), false);
        assert.equal(item.payload.retryable, false);
      }
    }
  } finally {
    try {
      await client?.close();
    } finally {
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        const exited = new Promise<void>((resolve) => worker!.once('exit', () => resolve()));
        worker.kill('SIGKILL');
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
});
