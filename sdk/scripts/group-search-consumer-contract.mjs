import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Compiled SDK only; all native services and kernel responses are controlled. */
export async function verifyGroupSearchConsumer(packageRoot) {
  const load = (name) => import(pathToFileURL(join(packageRoot, 'dist', name)).href);
  const [{ createNativeServices }, { supportsGroupSearch }, { prepareCommand }, { QQClient }] =
    await Promise.all([
      load('native-services.js'),
      load('native/native-contracts.js'),
      load('cli.js'),
      load('index.js'),
    ]);
  const version = '7.0.2-53644';
  const profile = {
    platform: 'darwin',
    arch: 'arm64',
    clientVersion: version,
    wrapperSha256: 'fbc8ad9b328d05e16784d76b0181dda894c17001179dbf8c0d5dd00dc6271358',
  };
  assert.equal(supportsGroupSearch(profile, version), true);
  assert.equal(supportsGroupSearch({ ...profile, wrapperSha256: '0'.repeat(64) }, version), false);
  const target = '00123';
  const result = {
    keyWord: target,
    errorode: 0,
    isEnd: true,
    groupInfos: [
      {
        groupCode: '123',
        searchGroupInfo: {
          groupCode: '123',
          groupName: 'fixture',
          memberNum: 1,
          maxMemberNum: 2,
          ownerUid: 'u_owner',
          fingerMemo: 'description',
        },
      },
    ],
  };
  const expected = {
    groupId: '123',
    name: 'fixture',
    memberCount: 1,
    maxMemberCount: 2,
    ownerUid: 'u_owner',
    description: 'description',
  };
  function fixture(response = result, nativeContracts = profile, pending = false) {
    let listener,
      calls = 0,
      registrations = 0;
    const search = {
      addKernelSearchListener(value) {
        listener = value;
        registrations++;
      },
      searchGroup(parameters) {
        assert.equal(this, search);
        calls++;
        assert.deepEqual(parameters, {
          keyWords: target,
          groupNum: 25,
          exactSearch: false,
          penetrate: '',
        });
        if (pending) return new Promise(() => {});
        listener.onSearchGroupResult(response);
        return { result: 0 };
      },
    };
    const services = createNativeServices({
      session: {
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getSearchService: () => search,
      },
      version,
      binaryProfile: nativeContracts,
      events: { emit() {} },
    });
    return { services, calls: () => calls, registrations: () => registrations };
  }
  const good = fixture();
  try {
    const [a, b] = await Promise.all([
      good.services.invokeOperation('searchGroup', { groupId: target }),
      good.services.invokeOperation('searchGroup', { groupId: target }),
    ]);
    assert.deepEqual(a, expected);
    assert.deepEqual(b, expected);
    assert.notEqual(a, b);
    assert.equal(good.calls(), 1);
    assert.equal(good.registrations(), 1);
  } finally {
    good.services.close();
  }
  for (const response of [
    { ...result, errorode: 73 },
    { ...result, groupInfos: Array(1) },
  ]) {
    const bad = fixture(response);
    try {
      await assert.rejects(bad.services.invokeOperation('searchGroup', { groupId: target }));
      await assert.rejects(
        bad.services.invokeOperation('searchGroup', { groupId: target }),
        /invalidated/,
      );
      assert.equal(bad.calls(), 1);
    } finally {
      bad.services.close();
    }
  }
  const denied = fixture(result, { ...profile, wrapperSha256: '0'.repeat(64) });
  try {
    await assert.rejects(denied.services.invokeOperation('searchGroup', { groupId: target }));
    assert.equal(denied.calls(), 0);
    assert.equal(denied.registrations(), 0);
  } finally {
    denied.services.close();
  }
  const waiting = fixture(result, profile, true);
  const request = waiting.services.invokeOperation('searchGroup', { groupId: target });
  const rejected = assert.rejects(request, /closed|abort/i);
  await new Promise((resolve) => setImmediate(resolve));
  waiting.services.close();
  let timer;
  try {
    await Promise.race([
      rejected,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Close did not settle search')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const plan = await prepareCommand('group-search', { 'group-id': target });
  assert.equal(await plan({ searchGroup: async (id) => id }), target);
  await assert.rejects(() =>
    prepareCommand('group-search', { 'group-id': '18446744073709551616' }),
  );
  assert.equal(typeof QQClient.prototype.searchGroup, 'function');
  const directory = await mkdtemp(join(tmpdir(), 'qq-search-worker-'));
  let client, child;
  try {
    const kernelUrl = pathToFileURL(await realpath(join(packageRoot, 'dist/kernel.js'))).href;
    const hook = join(directory, 'hook.mjs');
    await writeFile(
      hook,
      `import {registerHooks} from 'node:module';process.dlopen=()=>{};registerHooks({load(url,context,next){if(url!==${JSON.stringify(kernelUrl)})return next(url,context);return {format:'module',shortCircuit:true,source:${JSON.stringify(`export function createKernel(native,options,emit){return {async prepare(){},async close(){},async login(){const account={uin:'123',uid:'u_fixture'};emit('ready',account);return account;},async invokeOperation(method,payload){if(method!=='searchGroup'||payload.groupId!=='00123')throw Error('Unexpected search RPC');return ${JSON.stringify(expected)};}}}`)}}}});`,
    );
    child = fork(join(packageRoot, 'dist/worker.js'), [], {
      execArgv: ['--import', pathToFileURL(hook).href],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    client = new QQClient(child, 5000);
    await client.request('init', {
      options: {
        dataDir: directory,
        wrapperPath: join(directory, 'fixture.node'),
        version,
        preloadLibraries: [],
      },
    });
    await client.login({ method: 'restore', uin: '123' });
    assert.deepEqual(await client.searchGroup(target), expected);
    await client.close();
  } finally {
    if (client) await client.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
  return {
    groupSearchCompositionContract: true,
    groupSearchGateContract: true,
    groupSearchDtoContract: true,
    groupSearchCloseContract: true,
    groupSearchWorkerContract: true,
    groupSearchInstalledCliContract: true,
    nativeGroupSearchAttempted: false,
    accountUsed: false,
  };
}
