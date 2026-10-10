import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NativeWorkerBootstrap,
  type NativeBootstrapDependencies,
  type WorkerKernel,
} from '../src/worker/native-bootstrap.ts';
import type { ClientOptions, LoginRequest } from '../src/contracts/client.ts';
import type { KernelOptions } from '../src/kernel.ts';
import type { NativeObject } from '../src/native/native-object.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const options: ClientOptions = {
  dataDir: '/fake/data',
  wrapperPath: '/fake/wrapper.node',
  bridgePath: '/fake/bridge.node',
};
function fixture() {
  const calls: string[] = [],
    events: unknown[] = [];
  let releases = 0,
    kernelCloses = 0,
    logins = 0,
    operations = 0;
  let callback: ((name: string, payload: unknown) => void) | undefined;
  let acquiredOptions: KernelOptions | undefined, wrapper: NativeObject | undefined;
  const record = {
    async getDuration() {
      return 1;
    },
  };
  const video = {
    async getVideoInfo() {
      return { width: 1, height: 1, duration: 1, format: 'bmp' as const, image: Buffer.alloc(0) };
    },
  };
  const kernel: WorkerKernel = {
    async prepare() {
      assert.equal(this, kernel);
      calls.push('prepare');
    },
    async login(request) {
      assert.equal(this, kernel);
      assert.equal(request.method, 'qr');
      logins++;
      return { uin: '123', uid: 'u_fake' };
    },
    async invokeOperation(_method, payload, signal) {
      assert.equal(this, kernel);
      operations++;
      return { payload, signal };
    },
    async close() {
      assert.equal(this, kernel);
      kernelCloses++;
      calls.push('kernel.close');
    },
  };
  const dependencies: NativeBootstrapDependencies = {
    async createDataDirectory(path) {
      assert.equal(this, dependencies);
      calls.push(`mkdir:${path}`);
    },
    lockDataDirectory(path) {
      calls.push(`lock:${path}`);
      return () => {
        releases++;
        calls.push('release');
      };
    },
    loadAddon(target, path, flags) {
      assert.equal(this, dependencies);
      calls.push(`addon:${path}:${String(flags)}`);
      if (path === options.bridgePath) {
        const bridge = target.exports;
        bridge.preloadLibrary = function (library: string) {
          assert.equal(this, bridge);
          calls.push(`preload:${library}`);
        };
      } else target.exports = { fakeExport: true };
    },
    globalLoadFlags: 777,
    defaultPreloadLibraries: ['libgnutls.so.30'],
    async inspectNativeContracts(path, version) {
      calls.push(`inspect:${path}`);
      assert.equal(version, options.version);
      return undefined;
    },
    builtinRecordCodec: record,
    async loadRecordCodec(path) {
      calls.push(`record:${path}`);
      return record;
    },
    async loadVideoCodec(path) {
      calls.push(`video:${path}`);
      return video;
    },
    createKernel(native, config, emit) {
      calls.push('kernel');
      wrapper = native;
      acquiredOptions = config;
      callback = emit;
      return kernel;
    },
  };
  const owner = new NativeWorkerBootstrap(dependencies, (name, payload) =>
    events.push({ name, payload }),
  );
  return {
    owner,
    dependencies,
    kernel,
    calls,
    events,
    record,
    video,
    emit: (name: string, payload: unknown) => callback?.(name, payload),
    state: () => ({ releases, kernelCloses, logins, operations, acquiredOptions, wrapper }),
  };
}

for (const secondDirectory of ['/fake/data', '/fake/other'])
  test(`initialization reserves before mkdir awaits (${secondDirectory})`, async () => {
    const f = fixture(),
      waiting = deferred<unknown>();
    f.dependencies.createDataDirectory = (path) => {
      f.calls.push(`mkdir:${path}`);
      return waiting.promise;
    };
    const first = f.owner.initialize(options);
    await assert.rejects(
      f.owner.initialize({ ...options, dataDir: secondDirectory }),
      /already initialized/,
    );
    await assert.rejects(f.owner.login({ method: 'qr' }), /not initialized/);
    await assert.rejects(f.owner.invokeOperation('listFriends', {}), /not initialized/);
    assert.deepEqual(f.calls, ['mkdir:/fake/data']);
    waiting.resolve(undefined);
    await first;
    assert.equal(f.state().logins, 0);
    assert.equal(f.state().operations, 0);
    await f.owner.close();
    f.owner.releaseOnExit();
  });

test('bridge flags, preload receiver and codec/kernel arguments retain exact load order', async () => {
  const f = fixture();
  const configured = {
    ...options,
    recordCodecPath: '/fake/record',
    videoCodecPath: '/fake/video',
    rememberPassword: false,
    timeoutMs: 42,
    device: { hostname: 'fake' },
    mediaTools: { ffmpeg: '/fake/ffmpeg', ffprobe: '/fake/ffprobe' },
  };
  assert.deepEqual(await f.owner.initialize(configured), { exports: ['fakeExport'] });
  assert.deepEqual(f.calls, [
    'mkdir:/fake/data',
    'lock:/fake/data',
    'addon:/fake/bridge.node:777',
    'preload:libgnutls.so.30',
    'inspect:/fake/wrapper.node',
    'addon:/fake/wrapper.node:undefined',
    'record:/fake/record',
    'video:/fake/video',
    'kernel',
    'prepare',
  ]);
  assert.equal(f.state().acquiredOptions?.recordCodec, f.record);
  assert.equal(f.state().acquiredOptions?.videoCodec, f.video);
  assert.equal(f.state().acquiredOptions?.device, configured.device);
  assert.equal(f.state().acquiredOptions?.mediaTools, configured.mediaTools);
  assert.equal(f.state().acquiredOptions?.rememberPassword, false);
  assert.equal(f.state().acquiredOptions?.loginTimeoutMs, 42);
  assert.deepEqual(f.state().wrapper, { fakeExport: true });
  const request: LoginRequest = { method: 'qr' };
  await f.owner.login(request);
  const payload = {},
    signal = new AbortController().signal;
  assert.deepEqual(await f.owner.invokeOperation('listFriends', payload, signal), {
    payload,
    signal,
  });
  f.emit('ready-event', { fake: true });
  assert.equal(f.events.length, 1);
  await f.owner.close();
  assert.equal(f.state().releases, 0);
  f.emit('late-event', {});
  assert.equal(f.events.length, 1);
  f.owner.releaseOnExit();
  f.owner.releaseOnExit();
  assert.equal(f.state().releases, 1);
});

test('explicit preload override and builtin codec skip their optional acquisition ports', async () => {
  const f = fixture();
  await f.owner.initialize({ ...options, preloadLibraries: [] });
  assert.ok(
    !f.calls.some(
      (call) =>
        call.startsWith('preload:') || call.startsWith('record:') || call.startsWith('video:'),
    ),
  );
  assert.equal(f.state().acquiredOptions?.recordCodec, f.record);
  assert.equal(f.state().acquiredOptions?.videoCodec, undefined);
  await f.owner.close();
  f.owner.releaseOnExit();
});

for (const stage of ['mkdir', 'inspect', 'record', 'video', 'prepare'] as const)
  test(`close during ${stage} prevents readiness and later acquisition`, async () => {
    const f = fixture(),
      entered = deferred<void>(),
      waiting = deferred<void>();
    const configured = {
      ...options,
      recordCodecPath: '/fake/record',
      videoCodecPath: '/fake/video',
    };
    const block = async () => {
      entered.resolve();
      await waiting.promise;
    };
    if (stage === 'mkdir') f.dependencies.createDataDirectory = block;
    if (stage === 'inspect')
      f.dependencies.inspectNativeContracts = async () => {
        await block();
        return undefined;
      };
    if (stage === 'record')
      f.dependencies.loadRecordCodec = async () => {
        await block();
        return f.record;
      };
    if (stage === 'video')
      f.dependencies.loadVideoCodec = async () => {
        await block();
        return f.video;
      };
    if (stage === 'prepare') f.kernel.prepare = block;
    const initialization = f.owner.initialize(configured);
    void initialization.catch(() => {});
    await entered.promise;
    await assert.rejects(f.owner.login({ method: 'qr' }), /not initialized/);
    await assert.rejects(f.owner.invokeOperation('listFriends', {}), /not initialized/);
    const close = f.owner.close();
    assert.equal(f.owner.close(), close);
    await close;
    f.emit('late', {});
    waiting.resolve();
    await assert.rejects(initialization, /closed/);
    assert.equal(f.events.length, 0);
    assert.equal(f.state().kernelCloses, stage === 'prepare' ? 1 : 0);
    assert.equal(f.state().releases, 0);
    if (stage !== 'prepare') assert.ok(!f.calls.includes('kernel'));
    f.owner.releaseOnExit();
    f.owner.releaseOnExit();
    assert.equal(f.state().releases, stage === 'mkdir' ? 0 : 1);
  });

test('synchronous createKernel close retires the newly returned candidate exactly once', async () => {
  const f = fixture(),
    original = f.dependencies.createKernel;
  f.dependencies.createKernel = (...args) => {
    const kernel = original(...args);
    void f.owner.close();
    return kernel;
  };
  await assert.rejects(f.owner.initialize(options), /closed/);
  assert.equal(f.state().kernelCloses, 1);
  assert.ok(!f.calls.includes('prepare'));
  await f.owner.close();
  f.owner.releaseOnExit();
  assert.equal(f.state().kernelCloses, 1);
  assert.equal(f.state().releases, 1);
});

test('opaque prepare failure and cleanup error both survive, with no retry and lock held until exit', async () => {
  const f = fixture(),
    primary = { fakePrimary: true },
    cleanup = { fakeCleanup: true };
  f.kernel.prepare = async () => {
    throw primary;
  };
  f.kernel.close = async () => {
    f.calls.push('kernel.close');
    throw cleanup;
  };
  await assert.rejects(
    f.owner.initialize(options),
    (error: unknown) =>
      error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup,
  );
  await assert.rejects(f.owner.initialize(options), /already initialized/);
  assert.equal(f.calls.filter((call) => call.startsWith('addon:')).length, 2);
  assert.equal(f.calls.filter((call) => call === 'kernel.close').length, 1);
  assert.equal(f.state().releases, 0);
  f.emit('failed-late', {});
  assert.equal(f.events.length, 0);
  await assert.rejects(f.owner.close(), (error) => error === cleanup);
  f.owner.releaseOnExit();
  f.owner.releaseOnExit();
  assert.equal(f.state().releases, 1);
});

test('pre-native failure releases directory lock once and never retries initialization', async () => {
  const f = fixture(),
    primary = { directoryOnly: true };
  f.dependencies.defaultPreloadLibraries = [];
  f.dependencies.inspectNativeContracts = async () => {
    throw primary;
  };
  await assert.rejects(
    f.owner.initialize({ ...options, bridgePath: undefined }),
    (error) => error === primary,
  );
  assert.equal(f.state().releases, 1);
  await assert.rejects(f.owner.initialize(options), /already initialized/);
  await f.owner.close();
  f.owner.releaseOnExit();
  assert.equal(f.state().releases, 1);
});

test('late prepare rejection is observed after close without publishing events or readiness', async () => {
  const f = fixture(),
    entered = deferred<void>(),
    waiting = deferred<void>();
  f.kernel.prepare = () => {
    entered.resolve();
    return waiting.promise;
  };
  const pending = f.owner.initialize(options);
  void pending.catch(() => {});
  await entered.promise;
  await f.owner.close();
  const failure = { late: true };
  waiting.reject(failure);
  await assert.rejects(pending, (error) => error === failure);
  f.emit('late', {});
  await tick();
  assert.equal(f.events.length, 0);
  assert.equal(f.state().kernelCloses, 1);
  f.owner.releaseOnExit();
});

test('bridge preload method accessor closes bootstrap before any preload dispatch', async () => {
  const f = fixture();
  let reads = 0,
    preloads = 0;
  f.dependencies.loadAddon = (target, path) => {
    assert.equal(path, options.bridgePath);
    Object.defineProperty(target.exports, 'preloadLibrary', {
      get() {
        reads++;
        void f.owner.close();
        return () => {
          preloads++;
        };
      },
    });
  };
  await assert.rejects(f.owner.initialize(options), /closed/);
  assert.equal(preloads, 0);
  assert.equal(reads, 1);
  assert.equal(f.state().releases, 0);
  f.owner.releaseOnExit();
  assert.equal(f.state().releases, 1);
});

test('pre-native acquisition failure preserves primary and one release failure without repeating release', async () => {
  const f = fixture(),
    primary = { inspection: true },
    cleanup = { release: true };
  let attempts = 0;
  f.dependencies.defaultPreloadLibraries = [];
  f.dependencies.lockDataDirectory = () => () => {
    attempts++;
    throw cleanup;
  };
  f.dependencies.inspectNativeContracts = async () => {
    throw primary;
  };
  await assert.rejects(
    f.owner.initialize({ ...options, bridgePath: undefined }),
    (error: unknown) =>
      error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup,
  );
  await f.owner.close();
  f.owner.releaseOnExit();
  f.owner.releaseOnExit();
  assert.equal(attempts, 1);
});

for (const method of ['prepare', 'login', 'invokeOperation'] as const) {
  test(`${method} accessor synchronously closes owner without dispatch or repeated candidate cleanup`, async () => {
    const f = fixture();
    let reads = 0,
      dispatched = 0;
    if (method !== 'prepare') await f.owner.initialize(options);
    Object.defineProperty(f.kernel, method, {
      configurable: true,
      get() {
        reads++;
        void f.owner.close();
        return function (this: WorkerKernel) {
          assert.equal(this, f.kernel);
          dispatched++;
          return Promise.resolve(undefined);
        };
      },
    });
    const pending =
      method === 'prepare'
        ? f.owner.initialize(options)
        : method === 'login'
          ? f.owner.login({ method: 'qr' })
          : f.owner.invokeOperation('listFriends', {});
    await assert.rejects(pending, /Native worker is closed/);
    await f.owner.close();
    assert.equal(reads, 1);
    assert.equal(dispatched, 0);
    assert.equal(f.state().kernelCloses, 1);
    f.emit('late-accessor-callback', {});
    assert.equal(f.events.length, 0);
    assert.equal(f.state().releases, 0);
    f.owner.releaseOnExit();
    f.owner.releaseOnExit();
    assert.equal(f.state().releases, 1);
  });
}
