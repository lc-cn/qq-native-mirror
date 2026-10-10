import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Actual installed worker IPC and filesystem locks with only acquisition ports
 * replaced. No native addon, account, or HTTP operation is dispatched. */
export async function verifyWorkerBootstrapConsumer(packageRoot) {
  const directory = await mkdtemp(join(tmpdir(), 'qq-worker-bootstrap-'));
  const dist = await realpath(join(packageRoot, 'dist'));
  const worker = join(dist, 'worker.js');
  const { QQClient } = await import(pathToFileURL(join(dist, 'index.js')).href);
  const workerUrls = [worker, join(dist, 'worker/bootstrap.js')].map((p) => pathToFileURL(p).href);
  const kernelUrl = pathToFileURL(join(dist, 'kernel.js')).href;
  const contractsUrl = pathToFileURL(join(dist, 'native/native-contracts.js')).href;
  const children = [];
  const exists = async (p) => {
    try {
      await stat(join(p, '.qq-native-client.lock'));
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  };
  async function spawn(mode) {
    const hook = join(directory, `hook-${children.length}.mjs`);
    await writeFile(
      hook,
      `import {registerHooks} from 'node:module';
${mode === 'exit-delay' ? 'const originalExit=process.exit.bind(process);process.exit=(code)=>{const until=Date.now()+100;while(Date.now()<until){};originalExit(code);};' : ''}
process.dlopen=()=>{process.send({fixture:'addon'});${mode === 'dlopen-fail' ? "throw Error('controlled addon failure');" : ''}};
registerHooks({resolve(specifier,context,next){if(specifier==='node:fs/promises'&&${JSON.stringify(workerUrls)}.includes(context.parentURL))return {url:'fixture:mkdir',shortCircuit:true};return next(specifier,context);},load(url,context,next){
if(url==='fixture:mkdir')return {format:'module',shortCircuit:true,source:${JSON.stringify(`import {mkdir as realMkdir} from 'node:fs/promises';let release;process.on('message',m=>{if(m?.control==='release')release?.();});export async function mkdir(path,options){${mode === 'mkdir-hold' ? "process.send({fixture:'mkdir-held'});await new Promise(r=>release=r);" : ''}return realMkdir(path,options);}`)}};
if(url===${JSON.stringify(contractsUrl)})return {format:'module',shortCircuit:true,source:'export async function inspectNativeContracts(){return undefined;}'};
if(url===${JSON.stringify(kernelUrl)})return {format:'module',shortCircuit:true,source:${JSON.stringify(`let release;process.on('message',m=>{if(m?.control==='release')release?.();});export function createKernel(){process.send({fixture:'kernel-created'});return {async prepare(){${mode === 'prepare-hold' ? "process.send({fixture:'prepare-held'});await new Promise(r=>release=r);" : mode === 'prepare-fail' ? "throw Error('controlled prepare failure');" : ''}},async close(){process.send({fixture:'kernel-close'});},async login(){process.send({fixture:'login-dispatched'});return {uin:'123',uid:'fixture'};},async invokeOperation(){process.send({fixture:'business-dispatched'});return [];}};}`)}};return next(url,context);}});`,
    );
    const child = fork(worker, [], {
      execArgv: ['--import', pathToFileURL(hook).href],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const events = [];
    child.on('message', (m) => events.push(m));
    let exitResult;
    const exited = new Promise((resolve) =>
      child.once('exit', (code, signal) => {
        exitResult = { code, signal };
        resolve(exitResult);
      }),
    );
    children.push({ child, exited });
    const until = async (predicate) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (exitResult) throw Error('Worker exited before expected reply');
        if (Date.now() > deadline) throw Error('Controlled worker bootstrap deadline');
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const send = (id, method, extra = {}) => child.send({ id, method, ...extra });
    const init = (id, dataDir) =>
      send(id, 'init', {
        options: {
          dataDir,
          wrapperPath: join(directory, 'unused.node'),
          version: 'fixture',
          preloadLibraries: [],
        },
      });
    const reply = async (id) => {
      await until(() => events.some((e) => e.id === id));
      assert.equal(events.filter((e) => e.id === id).length, 1, 'One response per RPC');
      return events.find((e) => e.id === id);
    };
    const verifyExit = async () => {
      const result = await bounded(exited);
      assert.deepEqual(result, { code: 0, signal: null }, 'Controlled worker exits normally');
      const ids = events.filter((e) => typeof e.id === 'number').map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length, 'No duplicate RPC replies before exit');
    };
    const close = async () => {
      send(999, 'close');
      await verifyExit();
      const acknowledgements = events.filter((e) => e.id === 999);
      assert.equal(acknowledgements.length, 1, 'Close acknowledgement delivered before exit');
      assert.equal(acknowledgements[0].error, undefined);
      assert.equal(acknowledgements[0].result, null);
    };
    return { child, events, until, send, init, reply, close, exited, verifyExit };
  }
  async function bounded(promise) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('Worker exit deadline')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    for (const same of [true, false]) {
      const first = join(directory, `race-${same}`),
        second = same ? first : join(directory, 'race-second');
      const f = await spawn('mkdir-hold');
      f.init(1, first);
      await f.until(() => f.events.some((e) => e.fixture === 'mkdir-held'));
      f.init(2, second);
      const secondReply = await f.reply(2);
      assert.ok(secondReply.error, 'Second init must reject before waiting on mkdir');
      f.child.send({ control: 'release' });
      assert.equal((await f.reply(1)).error, undefined);
      assert.equal(f.events.filter((e) => e.fixture === 'kernel-created').length, 1);
      await f.close();
      assert.equal(await exists(first), false);
      assert.equal(await exists(second), false);
    }
    const pendingDir = join(directory, 'preparing'),
      pending = await spawn('prepare-hold');
    pending.init(1, pendingDir);
    await pending.until(() => pending.events.some((e) => e.fixture === 'prepare-held'));
    pending.send(2, 'login', { login: { method: 'restore', uin: '123' } });
    pending.send(3, 'listFriends', { payload: {} });
    assert.ok((await pending.reply(2)).error);
    assert.ok((await pending.reply(3)).error);
    assert.equal(
      pending.events.some(
        (e) => e.fixture === 'login-dispatched' || e.fixture === 'business-dispatched',
      ),
      false,
    );
    pending.child.send({ control: 'release' });
    await pending.reply(1);
    await pending.close();
    assert.equal(await exists(pendingDir), false);
    const normalDir = join(directory, 'reuse');
    for (const disconnect of [false, true, false]) {
      const f = await spawn('normal');
      f.init(1, normalDir);
      assert.equal((await f.reply(1)).error, undefined);
      assert.equal(await exists(normalDir), true);
      if (disconnect) {
        f.child.disconnect();
        await f.verifyExit();
      } else await f.close();
      assert.equal(await exists(normalDir), false);
    }
    for (const mode of ['dlopen-fail', 'prepare-fail']) {
      const path = join(directory, mode),
        f = await spawn(mode);
      f.init(1, path);
      assert.ok((await f.reply(1)).error);
      assert.equal(
        await exists(path),
        true,
        'Native-touched failed worker retains lock until exit',
      );
      f.init(2, path);
      assert.ok((await f.reply(2)).error);
      assert.equal(f.events.filter((e) => e.fixture === 'addon').length, 1);
      await f.close();
      assert.equal(await exists(path), false);
      assert.equal(
        f.events.filter((e) => e.fixture === 'kernel-close').length,
        mode === 'prepare-fail' ? 1 : 0,
      );
    }
    for (const mode of ['mkdir-hold', 'prepare-hold']) {
      const path = join(directory, 'close-' + mode),
        f = await spawn(mode);
      f.init(1, path);
      await f.until(() =>
        f.events.some((e) => e.fixture === (mode === 'mkdir-hold' ? 'mkdir-held' : 'prepare-held')),
      );
      await f.close();
      assert.equal(
        f.events.some((e) => e.id === 1 && !e.error),
        false,
        'Close during initialization cannot publish init success',
      );
      assert.equal(await exists(path), false);
    }
    const acknowledgedPath = join(directory, 'acknowledged-exit');
    const delayed = await spawn('exit-delay');
    const client = new QQClient(delayed.child, 5000);
    try {
      await client.request('init', {
        options: {
          dataDir: acknowledgedPath,
          wrapperPath: join(directory, 'unused.node'),
          version: 'fixture',
          preloadLibraries: [],
        },
      });
      assert.equal(await exists(acknowledgedPath), true);
      const closed = client.close();
      assert.equal(client.close(), closed);
      await closed;
      await delayed.verifyExit();
      assert.equal(delayed.events.filter((e) => e.id !== undefined && e.result === null).length, 1);
      assert.equal(
        await exists(acknowledgedPath),
        false,
        'Parent must allow acknowledged worker exit cleanup',
      );
    } finally {
      await client.close();
    }
    return {
      workerBootstrapSingleInitContract: true,
      workerBootstrapAcknowledgedExitContract: true,
      workerBootstrapPreparingGateContract: true,
      workerBootstrapLockReleaseContract: true,
      workerBootstrapNativeFailureLockContract: true,
      workerBootstrapCloseDuringInitContract: true,
      nativeExecuted: false,
      accountUsed: false,
      httpAttempted: false,
    };
  } finally {
    for (const { child, exited } of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await bounded(exited);
      }
    await rm(directory, { recursive: true, force: true });
  }
}
