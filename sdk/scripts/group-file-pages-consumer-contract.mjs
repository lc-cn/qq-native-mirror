import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Controlled source/installed contracts; never loads a QQ addon or account.
 * @param {string} packageRoot
 * @param {{source?:boolean}} [options]
 */
export async function verifyGroupFilePagesConsumer(packageRoot, options = {}) {
  const source = options.source === true;
  /** @type {Promise<typeof import('../src/features/groups/group-file-pages.ts')>} */
  const pagesImport = source
    ? import(pathToFileURL(join(packageRoot, 'src/features/groups/group-file-pages.ts')).href)
    : import(pathToFileURL(join(packageRoot, 'dist/features/groups/group-file-pages.js')).href);
  /** @type {Promise<typeof import('../src/features/groups/group-file-input.ts')>} */
  const inputImport = source
    ? import(pathToFileURL(join(packageRoot, 'src/features/groups/group-file-input.ts')).href)
    : import(pathToFileURL(join(packageRoot, 'dist/features/groups/group-file-input.js')).href);
  /** @type {Promise<typeof import('../src/native-services.ts')>} */
  const serviceImport = source
    ? import(pathToFileURL(join(packageRoot, 'src/native-services.ts')).href)
    : import(pathToFileURL(join(packageRoot, 'dist/native-services.js')).href);
  /** @type {Promise<typeof import('../src/index.ts')>} */
  const clientImport = source
    ? import(pathToFileURL(join(packageRoot, 'src/index.ts')).href)
    : import(pathToFileURL(join(packageRoot, 'dist/index.js')).href);
  /** @type {Promise<typeof import('../src/cli.ts')>} */
  const cliImport = source
    ? import(pathToFileURL(join(packageRoot, 'src/cli.ts')).href)
    : import(pathToFileURL(join(packageRoot, 'dist/cli.js')).href);
  /** @type {Promise<typeof import('../src/runtime/worker-termination.ts')>} */
  const terminationImport = source
    ? import(pathToFileURL(join(packageRoot, 'src/runtime/worker-termination.ts')).href)
    : import(pathToFileURL(join(packageRoot, 'dist/runtime/worker-termination.js')).href);
  const { terminateWorker } = await terminationImport;
  const [
    { createGroupFilePages, GroupFilePageHistory },
    input,
    { createNativeServices },
    { QQClient },
    { prepareCommand },
  ] = await Promise.all([pagesImport, inputImport, serviceImport, clientImport, cliImport]);
  const groupId = '00123';
  /** @satisfies {import('../src/contracts/groups.ts').GroupFileFolder} */
  const folder = {
    folderId: 'opaque-folder',
    parentFolderId: '',
    folderName: 'folder',
    createTime: 0,
    modifyTime: 4294967295,
    createUin: '0',
    creatorName: 'creator',
    totalFileCount: 1,
    modifyUin: '18446744073709551615',
    modifyName: 'modifier',
    usedSpace: '18446744073709551615',
  };
  /** @satisfies {import('../src/contracts/groups.ts').GroupFile} */
  const file = {
    fileModelId: '0',
    fileId: 'opaque-file',
    fileName: 'file',
    fileSize: '18446744073709551615',
    busId: 4294967295,
    uploadedSize: '0',
    uploadTime: 0,
    deadTime: 1,
    modifyTime: 2,
    downloadTimes: 3,
    sha: 'sha',
    sha3: 'sha3',
    md5: 'md5',
    uploaderLocalPath: null,
    uploaderName: 'uploader',
    uploaderUin: '0',
    parentFolderId: null,
    localPath: '/native/cache',
    transStatus: 0,
    transType: 4294967295,
    elementId: '18446744073709551615',
    isFolder: false,
  };
  const expected = { groupId: '123', type: -2147483648, folderInfo: folder, fileInfo: file };
  /** @param {number} token @param {boolean} end @param {number} next */
  const callback = (token, end, next) => ({
    reqId: token,
    retCode: 0,
    retMsg: '',
    clientWording: '',
    isEnd: end,
    item: [
      { peerId: '123', type: expected.type, folderInfo: { ...folder }, fileInfo: { ...file } },
    ],
    allFileCount: 2,
    nextIndex: next,
  });
  const captured = input.captureGroupFilePage(groupId, {
    sortType: -1,
    fileCount: 2,
    startIndex: 0,
  });
  assert.equal(captured.groupId, groupId);
  assert.equal(captured.params.sortType, -1);
  assert.throws(() => input.captureGroupFilePage(groupId, { fileCount: 0 }));
  assert.throws(() => input.captureGroupFileList(groupId, { startIndex: 1 }));
  const abort = new AbortController();
  const history = new GroupFilePageHistory();
  let calls = 0;
  const port = {
    /** @param {string} group @param {import('../src/features/groups/group-file-input.ts').GroupFileListParams} params */
    getGroupFileList(group, params) {
      assert.equal(this, port);
      assert.equal(group, groupId);
      const token = ++calls;
      owner.receiveFileInfo(callback(token, false, params.startIndex === 0 ? 7 : 8));
      owner.receiveFileInfo(callback(token, true, 8));
      return token;
    },
  };
  const owner = createGroupFilePages({
    signal: abort.signal,
    history,
    supportsFilePage: () => true,
    getFilePageService: () => port,
  });
  try {
    // First matching callback wins; a later same-token end cannot rewrite it.
    const first = await owner.getGroupFilePage(groupId, { fileCount: 2 });
    assert.deepEqual(first.items, [expected]);
    assert.equal(first.isEnd, false);
  } finally {
    owner.close();
  }
  let nextToken = 100;
  const listPort = {
    /** @param {string} group @param {import('../src/features/groups/group-file-input.ts').GroupFileListParams} params */
    getGroupFileList(group, params) {
      assert.equal(this, listPort);
      assert.equal(group, groupId);
      const token = ++nextToken;
      listed.receiveFileInfo(callback(token, params.startIndex === 7, 7));
      return token;
    },
  };
  const listed = createGroupFilePages({
    signal: new AbortController().signal,
    history: new GroupFilePageHistory(),
    supportsFilePage: () => true,
    getFilePageService: () => listPort,
  });
  try {
    assert.deepEqual(await listed.listGroupFiles(groupId, { maxPages: 2 }), [expected, expected]);
    assert.equal(nextToken, 102);
    await assert.rejects(listed.listGroupFiles(groupId, { maxPages: 1 }), /budget exhausted/);
    assert.equal(nextToken, 103);
  } finally {
    listed.close();
  }
  const stalled = createGroupFilePages({
    signal: new AbortController().signal,
    history: new GroupFilePageHistory(),
    supportsFilePage: () => true,
    getFilePageService: () => ({
      getGroupFileList() {
        return 500;
      },
    }),
  });
  const pending = stalled.getGroupFilePage(groupId);
  const closed = assert.rejects(pending, /closed/);
  stalled.receiveFileInfo(callback(501, true, 1));
  stalled.close();
  await closed;
  const timed = createGroupFilePages({
    signal: new AbortController().signal,
    history: new GroupFilePageHistory(),
    supportsFilePage: () => true,
    getFilePageService: () => ({
      getGroupFileList() {
        return 600;
      },
    }),
  });
  try {
    await assert.rejects(timed.getGroupFilePage(groupId), /timed out/);
  } finally {
    timed.close();
  }
  const sharedHistory = new GroupFilePageHistory();
  let zeroDispatches = 0;
  /** @type {ReturnType<typeof createGroupFilePages>|undefined} */
  let zeroOwner;
  const zeroPort = {
    getGroupFileList() {
      zeroDispatches++;
      assert.ok(zeroOwner);
      zeroOwner.receiveFileInfo(callback(0, true, 0));
      return 0;
    },
  };
  zeroOwner = createGroupFilePages({
    signal: new AbortController().signal,
    history: sharedHistory,
    supportsFilePage: () => true,
    getFilePageService: () => zeroPort,
  });
  try {
    assert.equal((await zeroOwner.getGroupFilePage(groupId)).isEnd, true);
  } finally {
    zeroOwner.close();
  }
  zeroOwner = createGroupFilePages({
    signal: new AbortController().signal,
    history: sharedHistory,
    supportsFilePage: () => true,
    getFilePageService: () => zeroPort,
  });
  try {
    await assert.rejects(zeroOwner.getGroupFilePage(groupId), /Duplicate/);
    assert.equal(zeroDispatches, 2);
  } finally {
    zeroOwner.close();
  }
  const profile = {
    platform: 'darwin',
    arch: 'arm64',
    clientVersion: '7.0.2-53644',
    wrapperSha256: 'fbc8ad9b328d05e16784d76b0181dda894c17001179dbf8c0d5dd00dc6271358',
  };
  const linuxArmProfile = {
    platform: 'linux',
    arch: 'arm64',
    clientVersion: '3.2.32-52194',
    wrapperSha256: 'c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337',
  };
  const linuxX64Profile = {
    platform: 'linux',
    arch: 'x64',
    clientVersion: '3.2.32-52194',
    wrapperSha256: '7882b8e3055cd38584861042befacd8be9939896f5cbbca6fa4a230926b48526',
  };
  // Controlled replacements share the real worker-lifetime token ledger.
  // Their token producer must keep advancing across account compositions too.
  let nextCompositionToken = 1000;
  /** @param {import('../src/native/native-contracts.ts').NativeContractProfile|undefined} binaryProfile
   * @param {string} [version]
   */
  function composition(
    binaryProfile,
    version = binaryProfile?.clientVersion ?? profile.clientVersion,
  ) {
    /** @type {{onGroupFileInfoUpdate(raw:unknown):void}|undefined} */ let listener;
    let acquired = 0;
    const rich = {
      /** @param {string} group @param {import('../src/features/groups/group-file-input.ts').GroupFileListParams} params */
      getGroupFileList(group, params) {
        assert.equal(this, rich);
        assert.equal(group, groupId);
        const token = ++nextCompositionToken;
        assert.ok(listener);
        listener.onGroupFileInfoUpdate(callback(token, params.startIndex === 7, 7));
        return token;
      },
    };
    const services = createNativeServices({
      session: {
        getMsgService: () => ({
          /** @param {{onGroupFileInfoUpdate(raw:unknown):void}} value */
          addKernelMsgListener(value) {
            listener = value;
          },
        }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getRichMediaService() {
          acquired++;
          return rich;
        },
      },
      version,
      binaryProfile,
      events: { emit() {} },
    });
    return { services, acquired: () => acquired };
  }
  for (const verifiedProfile of [profile, linuxArmProfile, linuxX64Profile]) {
    const good = composition(verifiedProfile);
    try {
      assert.deepEqual(
        await good.services.invokeOperation('listGroupFiles', {
          groupId,
          options: { maxPages: 2 },
        }),
        [expected, expected],
      );
      assert.equal(good.acquired(), 2);
    } finally {
      good.services.close();
    }
  }
  for (const supported of [profile, linuxArmProfile, linuxX64Profile]) {
    for (const changedProfile of [
      { ...supported, platform: 'unknown' },
      { ...supported, arch: 'unknown' },
      { ...supported, wrapperSha256: '0'.repeat(64) },
      { ...supported, clientVersion: 'unverified' },
    ]) {
      const bad = composition(changedProfile);
      try {
        await assert.rejects(bad.services.invokeOperation('getGroupFilePage', { groupId }), {
          code: 'unsupported-native-contract',
        });
        assert.equal(bad.acquired(), 0);
      } finally {
        bad.services.close();
      }
    }
    const wrongVersion = composition(supported, 'unverified');
    try {
      await assert.rejects(wrongVersion.services.invokeOperation('getGroupFilePage', { groupId }), {
        code: 'unsupported-native-contract',
      });
      assert.equal(wrongVersion.acquired(), 0);
    } finally {
      wrongVersion.services.close();
    }
  }
  for (const [platform, arch] of [
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['win32', 'x64'],
    ['win32', 'arm64'],
  ]) {
    const bad = composition({ ...profile, platform, arch });
    try {
      await assert.rejects(bad.services.invokeOperation('getGroupFilePage', { groupId }), {
        code: 'unsupported-native-contract',
      });
      assert.equal(bad.acquired(), 0);
    } finally {
      bad.services.close();
    }
  }
  const plan = await prepareCommand('group-file-list', {
    'group-id': groupId,
    'file-count': '2',
    'start-index': '0',
    'sort-type': '-1',
  });
  const allPlan = await prepareCommand('group-file-all', { 'group-id': groupId, 'max-pages': '2' });
  await assert.rejects(
    prepareCommand('group-file-list', { 'group-id': groupId, 'file-count': '0' }),
  );
  await assert.rejects(prepareCommand('group-file-all', { 'group-id': groupId, 'max-pages': '0' }));
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'group-file-consumer-')));
  /** @type {import('node:child_process').ChildProcess|undefined} */ let child;
  /** @type {InstanceType<typeof QQClient>|undefined} */ let client;
  try {
    const kernelPath = join(packageRoot, source ? 'src/kernel.ts' : 'dist/kernel.js');
    const kernelUrl = pathToFileURL(await realpath(kernelPath)).href;
    const page = {
      groupId,
      startIndex: 0,
      fileCount: 2,
      items: [expected],
      isEnd: false,
      nextIndex: 7,
      allFileCount: 2,
    };
    const fake = `export function createKernel(native,options,emit){return {async prepare(){},async close(){},async login(){const account={uin:'123',uid:'u_fixture'};emit('ready',account);return account;},async invokeOperation(method,payload){if(payload.groupId!==${JSON.stringify(groupId)})throw Error('wrong group');if(method==='getGroupFilePage'){if(payload.options.fileCount!==2||payload.options.sortType!==-1)throw Error('wrong options');return ${JSON.stringify(page)};}if(method==='listGroupFiles'){if(payload.options.maxPages!==2)throw Error('wrong budget');return ${JSON.stringify([expected, expected])};}throw Error('wrong operation');}}}`;
    const hook = join(directory, 'hook.mjs');
    await writeFile(
      hook,
      `import {registerHooks} from 'node:module';process.dlopen=()=>{};registerHooks({load(url,context,next){if(url!==${JSON.stringify(kernelUrl)})return next(url,context);return {format:'module',shortCircuit:true,source:${JSON.stringify(fake)}};}});`,
    );
    child = fork(join(packageRoot, source ? 'src/worker.ts' : 'dist/worker.js'), [], {
      execArgv: ['--import', pathToFileURL(hook).href],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    client = new QQClient(child, 5000);
    await client.request('init', {
      options: {
        dataDir: directory,
        wrapperPath: join(directory, 'fixture.node'),
        version: profile.clientVersion,
        preloadLibraries: [],
      },
    });
    await client.login({ method: 'restore', uin: '123' });
    assert.deepEqual(await plan(client), page);
    assert.deepEqual(await allPlan(client), [expected, expected]);
    await client.close();
    await terminateWorker(child, { forceDelayMs: 250, deadlineMs: 1500 });
    const nativeServicesUrl = pathToFileURL(
      await realpath(
        join(packageRoot, source ? 'src/native-services.ts' : 'dist/native-services.js'),
      ),
    ).href;
    const cancellationKernel = `
import {createNativeServices} from ${JSON.stringify(nativeServicesUrl)};
const report=fixture=>process.send?.({fixture});
let mode='stall',calls=0,listener,pendingToken,closes=0;
const cb=(reqId,end)=>({...${JSON.stringify(callback(1, true, 7))},reqId,isEnd:end});
process.on('message',message=>{if(message?.fixtureControl==='success'){mode='success';report('success-mode');}if(message?.fixtureControl==='release-late-page'){listener.onGroupFileInfoUpdate(cb(pendingToken,false));setImmediate(()=>report('late-released:'+calls));}});
export function createKernel(native,options,emit){
 const rich={getGroupFileList(group,params){const token=++calls;pendingToken=token;report('dispatch:'+calls);if(mode==='success')listener.onGroupFileInfoUpdate(cb(token,true));return token;}};
 const services=createNativeServices({session:{getMsgService:()=>({addKernelMsgListener(value){listener=value;}}),getBuddyService:()=>({addKernelBuddyListener(){}}),getGroupService:()=>({addKernelGroupListener(){}}),getRichMediaService:()=>rich},version:${JSON.stringify(profile.clientVersion)},binaryProfile:${JSON.stringify(profile)},events:{emit(){}}});
 return {async prepare(){},async login(){const account={uin:'123',uid:'u_fixture'};emit('ready',account);return account;},async invokeOperation(method,payload,signal){try{return await services.invokeOperation(method,payload,signal);}finally{report('settled:'+method+':'+signal?.aborted);}},async close(){closes++;services.close();report('closed:'+closes);}};
}`;
    await writeFile(
      hook,
      `import {registerHooks} from 'node:module';process.dlopen=()=>{};registerHooks({load(url,context,next){if(url!==${JSON.stringify(kernelUrl)})return next(url,context);return {format:'module',shortCircuit:true,source:${JSON.stringify(cancellationKernel)}};}});`,
    );
    child = fork(join(packageRoot, source ? 'src/worker.ts' : 'dist/worker.js'), [], {
      execArgv: ['--import', pathToFileURL(hook).href],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    /** @type {string[]} */ const events = [];
    /** @type {Map<string,()=>void>} */ const waiting = new Map();
    child.on('message', (message) => {
      if (
        message &&
        typeof message === 'object' &&
        'fixture' in message &&
        typeof message.fixture === 'string'
      ) {
        events.push(message.fixture);
        waiting.get(message.fixture)?.();
      }
    });
    /** @param {string} event */
    const until = (event) =>
      events.includes(event)
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              waiting.delete(event);
              reject(Error('Missing controlled group-file event: ' + event));
            }, 3000);
            waiting.set(event, () => {
              clearTimeout(timer);
              waiting.delete(event);
              resolve(undefined);
            });
          });
    client = new QQClient(child, 5000);
    await client.request('init', {
      options: {
        dataDir: join(directory, 'cancel-account'),
        wrapperPath: join(directory, 'fixture.node'),
        version: profile.clientVersion,
        preloadLibraries: [],
      },
    });
    await client.login({ method: 'restore', uin: '123' });
    const cancelledPage = assert.rejects(
      client.request('getGroupFilePage', { groupId }, 150),
      /timed out/,
    );
    await until('dispatch:1');
    await cancelledPage;
    await until('settled:getGroupFilePage:true');
    const cancelledList = assert.rejects(
      client.request('listGroupFiles', { groupId, options: { maxPages: 2 } }, 150),
      /timed out/,
    );
    await until('dispatch:2');
    await cancelledList;
    await until('settled:listGroupFiles:true');
    child.send({ fixtureControl: 'release-late-page' });
    await until('late-released:2');
    child.send({ fixtureControl: 'success' });
    await until('success-mode');
    assert.deepEqual((await client.getGroupFilePage(groupId)).items, [expected]);
    assert.deepEqual(
      events.filter((event) => event.startsWith('dispatch:')),
      ['dispatch:1', 'dispatch:2', 'dispatch:3'],
    );
    assert.equal(
      events.some((event) => event.startsWith('closed:')),
      false,
      'Cancellation cannot close the account services',
    );
    await client.close();
  } finally {
    try {
      if (client) await client.close();
    } finally {
      try {
        if (child) await terminateWorker(child, { forceDelayMs: 250, deadlineMs: 1500 });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
  return {
    groupFilePageInputContract: true,
    groupFileCompleteDtoContract: true,
    groupFilePaginationContract: true,
    groupFileCorrelationCloseContract: true,
    groupFileCompositionGateContract: true,
    groupFileLinuxX64CompositionContract: true,
    groupFileInstalledWorkerCliContract: true,
    groupFileWorkerCancellationContract: true,
    nativeGroupFileQueryAttempted: false,
    accountUsed: false,
  };
}
