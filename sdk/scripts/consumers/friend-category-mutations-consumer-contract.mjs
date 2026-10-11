import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ChildProcess, fork } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Parse only the provenance fields actually consumed by capability checks.
 * @param {string} packageRoot
 * @param {string} file
 * @returns {Promise<import('../../src/native/native-contracts.ts').NativeContractProfile[]>} */
async function readProfiles(packageRoot, file) {
  /** @type {unknown} */
  const value = JSON.parse(await readFile(join(packageRoot, 'docs/evidence', file), 'utf8'));
  assert.ok(
    value && typeof value === 'object' && 'profiles' in value && Array.isArray(value.profiles),
  );
  return value.profiles.map((/** @type {unknown} */ profile) => {
    assert.ok(
      profile &&
        typeof profile === 'object' &&
        'platform' in profile &&
        'arch' in profile &&
        'clientVersion' in profile &&
        'wrapperSha256' in profile,
    );
    const { platform, arch, clientVersion, wrapperSha256 } = profile;
    assert.ok(
      typeof platform === 'string' &&
        typeof arch === 'string' &&
        typeof clientVersion === 'string' &&
        typeof wrapperSha256 === 'string',
    );
    return { platform, arch, clientVersion, wrapperSha256 };
  });
}

/** Compiled package contracts with controlled services; no QQ operation. */
/** @param {string} packageRoot */
export async function verifyFriendCategoryMutationsConsumer(packageRoot) {
  const { createNativeServices } =
    await /** @type {Promise<typeof import('../../src/native-services.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/native-services.js')).href)
    );
  const { QQClient } = await /** @type {Promise<typeof import('../../src/index.ts')>} */ (
    import(pathToFileURL(join(packageRoot, 'dist/index.js')).href)
  );
  const assignmentChecks = await verifyAssignment(packageRoot, createNativeServices, QQClient);
  const { prepareCommand } = await /** @type {Promise<typeof import('../../src/cli.ts')>} */ (
    import(pathToFileURL(join(packageRoot, 'dist/cli.js')).href)
  );
  const profiles = await readProfiles(packageRoot, 'group-search-contract.json');
  const verifiedProfiles = await readProfiles(packageRoot, 'friend-category-rename-contract.json');
  /** @param {import('../../src/native/native-contracts.ts').NativeContractProfile|undefined} a
   * @param {import('../../src/native/native-contracts.ts').NativeContractProfile|undefined} b */
  const matches = (a, b) =>
    a &&
    b &&
    /** @type {const} */ (['platform', 'arch', 'clientVersion', 'wrapperSha256']).every(
      (key) => a[key] === b[key],
    );
  /** @param {import('../../src/native/native-contracts.ts').NativeContractProfile|undefined} profile */
  const isVerified = (profile) => verifiedProfiles.some((p) => matches(p, profile));
  assert.equal(verifiedProfiles.length, 4);
  assert.equal(profiles.length, 6);
  const deleteProfiles = await readProfiles(packageRoot, 'friend-category-delete-contract.json');
  assert.equal(deleteProfiles.length, 3);
  const reorderProfiles = await readProfiles(packageRoot, 'friend-category-reorder-contract.json');
  assert.equal(reorderProfiles.length, 1);
  assert.equal(reorderProfiles[0].platform, 'linux');
  assert.equal(reorderProfiles[0].arch, 'x64');
  assert.deepEqual(deleteProfiles.map(({ platform, arch }) => `${platform}-${arch}`).sort(), [
    'darwin-arm64',
    'linux-arm64',
    'linux-x64',
  ]);
  for (const profile of [
    ...profiles,
    undefined,
    ...profiles.filter(isVerified).map((p) => ({ ...p, wrapperSha256: '0'.repeat(64) })),
  ]) {
    let acquisitions = 0;
    /** @type {unknown[][]} */
    const calls = [];
    const buddy = {
      addKernelBuddyListener() {},
      renameCategory(/** @type {[number,string]} */ ...args) {
        assert.equal(this, buddy);
        assert.equal(args.length, 2);
        calls.push(args);
        return { result: 0 };
      },
    };
    const services = createNativeServices({
      session: {
        getBuddyService() {
          acquisitions++;
          return buddy;
        },
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
      },
      version: profile?.clientVersion ?? 'unknown',
      binaryProfile: profile,
      events: { emit() {} },
    });
    acquisitions = 0;
    try {
      const verified = isVerified(profile);
      if (verified) {
        assert.equal(
          await services.invokeOperation('renameFriendCategory', {
            categoryId: 0xffff_ffff,
            name: ' spelling ',
          }),
          undefined,
        );
        assert.deepEqual(calls, [[0xffff_ffff, ' spelling ']]);
      } else {
        await assert.rejects(
          services.invokeOperation('renameFriendCategory', { categoryId: 1, name: 'new' }),
        );
        assert.equal(acquisitions, 0);
        assert.deepEqual(calls, []);
      }
    } finally {
      services.close();
    }
  }
  const deletionCases = [
    ...profiles,
    undefined,
    ...deleteProfiles.flatMap((profile) =>
      ['platform', 'arch', 'clientVersion', 'wrapperSha256'].map((key) => ({
        ...profile,
        [key]: 'unverified',
      })),
    ),
  ].map((profile) => ({ profile, version: profile?.clientVersion ?? 'unknown' }));
  deletionCases.push(...deleteProfiles.map((profile) => ({ profile, version: 'wrong-version' })));
  for (const { profile, version } of deletionCases) {
    let acquisitions = 0;
    /** @type {unknown[][]} */
    const deleted = [];
    const buddy = {
      addKernelBuddyListener() {},
      delCategory(/** @type {[number]} */ ...args) {
        assert.equal(this, buddy);
        assert.equal(args.length, 1);
        deleted.push(args);
        return { result: 0 };
      },
    };
    const services = createNativeServices({
      session: {
        getBuddyService() {
          acquisitions++;
          return buddy;
        },
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
      },
      version,
      binaryProfile: profile,
      events: { emit() {} },
    });
    acquisitions = 0;
    try {
      if (
        profile?.clientVersion === version &&
        deleteProfiles.some((verified) => matches(verified, profile))
      ) {
        await services.invokeOperation('deleteFriendCategory', { categoryId: 0xffff_ffff });
        assert.deepEqual(deleted, [[0xffff_ffff]]);
      } else {
        await assert.rejects(services.invokeOperation('deleteFriendCategory', { categoryId: 0 }), {
          code: 'unsupported-native-contract',
        });
        assert.equal(acquisitions, 0);
        assert.deepEqual(deleted, []);
      }
    } finally {
      services.close();
    }
  }
  const order = [
    { categoryId: 0xffff_ffff, name: ' exact 中文 ' },
    { categoryId: 0, name: '' },
  ];
  /** @type {[import('../../src/native/native-contracts.ts').NativeContractProfile|undefined,string][]} */
  const reorderCases = [
    ...profiles.map(
      (profile) => /** @type {[typeof profile,string]} */ ([profile, profile.clientVersion]),
    ),
    [undefined, 'unknown'],
    [reorderProfiles[0], 'wrong-version'],
    ...['platform', 'arch', 'clientVersion', 'wrapperSha256'].map(
      (key) =>
        /** @type {[import('../../src/native/native-contracts.ts').NativeContractProfile,string]} */ ([
          { ...reorderProfiles[0], [key]: 'unverified' },
          reorderProfiles[0].clientVersion,
        ]),
    ),
  ];
  for (const [profile, version] of reorderCases) {
    let acquisitions = 0;
    /** @type {unknown[][]} */
    const calls = [];
    const buddy = {
      addKernelBuddyListener() {},
      resortCategory(
        /** @type {Parameters<NonNullable<import('../../src/features/contacts/friend-category-mutations.ts').FriendCategoryMutationsPort['resortCategory']>>} */ ...args
      ) {
        assert.equal(this, buddy);
        calls.push(args);
        return { result: 0 };
      },
    };
    const services = createNativeServices({
      session: {
        getBuddyService() {
          acquisitions++;
          return buddy;
        },
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
      },
      version,
      binaryProfile: profile,
      events: { emit() {} },
    });
    acquisitions = 0;
    try {
      if (
        profile?.clientVersion === version &&
        reorderProfiles.some((verified) => matches(verified, profile))
      ) {
        await services.invokeOperation('reorderFriendCategories', { categories: order });
        assert.deepEqual(calls, [
          [order.map(({ categoryId, name }) => ({ categoryId, categroyName: name }))],
        ]);
      } else {
        await assert.rejects(
          services.invokeOperation('reorderFriendCategories', { categories: order }),
          { code: 'unsupported-native-contract' },
        );
        assert.equal(acquisitions, 0);
        assert.deepEqual(calls, []);
      }
    } finally {
      services.close();
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'qq-category-order-consumer-'));
  const worker = new ChildProcess();
  /** @type {(Record<string,unknown>&{id:number,method:string})[]} */
  const calls = [];
  Object.defineProperty(worker, 'connected', { value: true, configurable: true });
  Object.defineProperty(worker, 'send', {
    value: (
      /** @type {Record<string,unknown>&{id:number,method:string}} */ value,
      /** @type {(error:Error|null)=>void} */ callback,
    ) => {
      calls.push(value);
      callback(null);
      queueMicrotask(() => worker.emit('message', { id: value.id, result: undefined }));
      return true;
    },
  });
  const client = new QQClient(worker, 500);
  try {
    worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'fixture' } });
    await client.renameFriendCategory(0, ' exact ');
    assert.deepEqual(
      { categoryId: calls[0].categoryId, name: calls[0].name, method: calls[0].method },
      { categoryId: 0, name: ' exact ', method: 'renameFriendCategory' },
    );
    const command = await prepareCommand('friend-category-rename', {
      'category-id': '4294967295',
      name: ' final ',
    });
    await command(client);
    assert.deepEqual(
      { categoryId: calls[1].categoryId, name: calls[1].name },
      { categoryId: 0xffff_ffff, name: ' final ' },
    );
    for (const id of ['-1', '1.5', '4294967296', 'abc'])
      await assert.rejects(
        prepareCommand('friend-category-rename', { 'category-id': id, name: 'new' }),
      );
    assert.equal(calls.length, 2);
    await client.deleteFriendCategory(0);
    const deletion = await prepareCommand('friend-category-delete', {
      'category-id': '4294967295',
    });
    await deletion(client);
    assert.deepEqual(
      calls.slice(2).map(({ method, categoryId }) => ({ method, categoryId })),
      [
        { method: 'deleteFriendCategory', categoryId: 0 },
        { method: 'deleteFriendCategory', categoryId: 0xffff_ffff },
      ],
    );
    for (const id of ['-1', '1.5', '4294967296', 'abc'])
      await assert.rejects(prepareCommand('friend-category-delete', { 'category-id': id }));
    assert.equal(calls.length, 4);
    await client.reorderFriendCategories(order);
    const file = join(directory, 'categories.json');
    await writeFile(file, JSON.stringify(order));
    const reorder = await prepareCommand('friend-category-reorder', { 'categories-file': file });
    await writeFile(file, 'invalid after preparation');
    await reorder(client);
    assert.deepEqual(
      calls.slice(4).map(({ method, categories }) => ({ method, categories })),
      [
        { method: 'reorderFriendCategories', categories: order },
        { method: 'reorderFriendCategories', categories: order },
      ],
    );
    await assert.rejects(prepareCommand('friend-category-reorder', { 'categories-file': file }));
    await assert.rejects(
      Reflect.apply(client.reorderFriendCategories, client, [
        [{ categoryId: '1', name: 'invalid' }],
      ]),
    );
    assert.equal(calls.length, 6);
  } finally {
    Object.defineProperty(worker, 'connected', { value: false, configurable: true });
    Object.defineProperty(worker, 'exitCode', { value: 0, configurable: true });
    worker.emit('exit', 0, null);
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
  return {
    ...assignmentChecks,
    friendCategoryRenameBinaryGateContract: true,
    friendCategoryRenameCompositionContract: true,
    friendCategoryRenameFacadeContract: true,
    friendCategoryRenameCliContract: true,
    nativeFriendCategoryRenameAttempted: false,
    friendCategoryDeleteBinaryGateContract: true,
    friendCategoryDeleteCompositionContract: true,
    friendCategoryDeleteVerifiedProfileCount: deleteProfiles.length,
    friendCategoryDeleteFacadeContract: true,
    friendCategoryDeleteCliContract: true,
    nativeFriendCategoryDeleteAttempted: false,
    friendCategoryReorderBinaryGateContract: true,
    friendCategoryReorderCompositionContract: true,
    friendCategoryReorderFacadeContract: true,
    friendCategoryReorderCliContract: true,
    nativeFriendCategoryReorderAttempted: false,
    accountUsed: false,
  };
}

/** Exercise the installed composition and real worker allowlist using fixture services only. */
/** @param {string} packageRoot
 * @param {typeof import('../../src/native-services.ts').createNativeServices} createNativeServices
 * @param {typeof import('../../src/index.ts').QQClient} QQClient */
async function verifyAssignment(packageRoot, createNativeServices, QQClient) {
  const { prepareCommand } = await /** @type {Promise<typeof import('../../src/cli.ts')>} */ (
    import(pathToFileURL(join(packageRoot, 'dist/cli.js')).href)
  );
  const profiles = await readProfiles(packageRoot, 'friend-category-assignment-contract.json');
  /** @param {import('../../src/native/native-contracts.ts').NativeContractProfile} expected
   * @param {import('../../src/native/native-contracts.ts').NativeContractProfile|undefined} value */
  const matches = (expected, value) =>
    !!value &&
    expected.platform === value.platform &&
    expected.arch === value.arch &&
    expected.clientVersion === value.clientVersion &&
    expected.wrapperSha256 === value.wrapperSha256;
  // Independent expected identities; capability implementation is never the oracle.
  const expectedProfiles = [
    {
      platform: 'linux',
      arch: 'x64',
      clientVersion: '3.2.32-52194',
      wrapperSha256: '7882b8e3055cd38584861042befacd8be9939896f5cbbca6fa4a230926b48526',
    },
    {
      platform: 'linux',
      arch: 'arm64',
      clientVersion: '3.2.32-52194',
      wrapperSha256: 'c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337',
    },
    {
      platform: 'darwin',
      arch: 'arm64',
      clientVersion: '7.0.2-53644',
      wrapperSha256: 'fbc8ad9b328d05e16784d76b0181dda894c17001179dbf8c0d5dd00dc6271358',
    },
    {
      platform: 'win32',
      arch: 'x64',
      clientVersion: '9.9.33-52230',
      wrapperSha256: '63112ab9161e127f5f7e17998a7196e143808923fb54cbbf7b4e21426187a5f0',
    },
  ];
  assert.equal(profiles.length, expectedProfiles.length);
  for (const expected of expectedProfiles)
    assert.equal(profiles.filter((value) => matches(expected, value)).length, 1);
  const allProfiles = await readProfiles(packageRoot, 'group-search-contract.json');
  assert.equal(allProfiles.length, 6);
  /** @type {[import('../../src/native/native-contracts.ts').NativeContractProfile|undefined,string][]} */
  const cases = [
    ...allProfiles.map(
      (value) => /** @type {[typeof value,string]} */ ([value, value.clientVersion]),
    ),
    ...expectedProfiles.flatMap((expected) => [
      /** @type {[typeof expected|undefined,string]} */ ([expected, expected.clientVersion]),
      /** @type {[typeof expected|undefined,string]} */ ([undefined, expected.clientVersion]),
      /** @type {[typeof expected|undefined,string]} */ ([expected, 'wrong-version']),
      ...['platform', 'arch', 'clientVersion', 'wrapperSha256'].map(
        (key) =>
          /** @type {[typeof expected|undefined,string]} */ ([
            { ...expected, [key]: 'wrong' },
            expected.clientVersion,
          ]),
      ),
    ]),
  ];
  for (const expected of expectedProfiles) {
    for (const key of ['platform', 'arch', 'clientVersion', 'wrapperSha256']) {
      const incomplete = { ...expected };
      Reflect.deleteProperty(incomplete, key);
      cases.push([incomplete, expected.clientVersion]);
    }
    for (const other of expectedProfiles.filter((value) => value !== expected))
      cases.push([{ ...expected, wrapperSha256: other.wrapperSha256 }, expected.clientVersion]);
  }
  for (const [binaryProfile, version] of cases) {
    let buddyAcquisitions = 0,
      uidAcquisitions = 0;
    /** @type {unknown[][]} */
    const calls = [];
    const buddy = {
      addKernelBuddyListener() {},
      setBuddyCategory(/** @type {[string,number]} */ ...args) {
        assert.equal(this, buddy);
        assert.equal(args.length, 2);
        calls.push(args);
        return { result: 0 };
      },
    };
    const services = createNativeServices({
      session: {
        getBuddyService() {
          buddyAcquisitions++;
          return buddy;
        },
        getUixConvertService() {
          uidAcquisitions++;
          return {
            getUid(/** @type {string[]} */ ids) {
              assert.deepEqual(ids, ['000123']);
              return { uidInfo: new Map([['000123', 'u_exact']]) };
            },
          };
        },
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
      },
      version,
      binaryProfile,
      events: { emit() {} },
    });
    buddyAcquisitions = uidAcquisitions = 0;
    try {
      if (
        binaryProfile?.clientVersion === version &&
        expectedProfiles.some((expected) => matches(expected, binaryProfile))
      ) {
        await services.invokeOperation('setFriendCategory', {
          userId: '000123',
          categoryId: 0xffff_ffff,
        });
        assert.deepEqual(calls, [['u_exact', 0xffff_ffff]]);
        assert.equal(uidAcquisitions, 1);
        assert.equal(buddyAcquisitions, 1);
      } else {
        await assert.rejects(
          services.invokeOperation('setFriendCategory', { userId: '000123', categoryId: 1 }),
          { code: 'unsupported-native-contract' },
        );
        assert.equal(buddyAcquisitions, 0);
        assert.equal(uidAcquisitions, 0);
        assert.deepEqual(calls, []);
      }
    } finally {
      services.close();
    }
  }
  for (const profile of expectedProfiles) {
    let calls = 0;
    /** @type {(value:unknown)=>void} */
    let resolveUid = () => assert.fail('UID resolver missing');
    /** @type {unknown} */
    let acknowledgement = { result: 73, errMsg: 'private fixture detail' };
    const buddy = {
      addKernelBuddyListener() {},
      setBuddyCategory() {
        calls++;
        return acknowledgement;
      },
    };
    const services = createNativeServices({
      session: {
        getBuddyService: () => buddy,
        getUixConvertService: () => ({
          getUid: () => ({ uidInfo: new Map([['123', 'u_exact']]) }),
        }),
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
      },
      version: profile.clientVersion,
      binaryProfile: profile,
      events: { emit() {} },
    });
    try {
      await assert.rejects(
        services.invokeOperation('setFriendCategory', { userId: '123', categoryId: 0 }),
        (error) => {
          assert.ok(error instanceof Error && 'code' in error);
          return error.code === 73 && !error.message.includes('private fixture detail');
        },
      );
      assert.equal(calls, 1);
      for (const malformed of [
        { result: '0', errMsg: 'private fixture detail' },
        {},
        { result: 0x8000_0000, errMsg: 'private fixture detail' },
      ]) {
        acknowledgement = malformed;
        /** @type {number} */
        const before = calls;
        await assert.rejects(
          services.invokeOperation('setFriendCategory', { userId: '123', categoryId: 1 }),
          (error) => error instanceof Error && !error.message.includes('private fixture detail'),
        );
        assert.equal(calls, before + 1, 'Malformed ACK must not retry the mutation');
      }
      for (const payload of [
        { userId: '0', categoryId: 1 },
        { userId: '123', categoryId: -1 },
        { userId: '123', categoryId: '1' },
      ])
        await assert.rejects(services.invokeOperation('setFriendCategory', payload));
      assert.equal(calls, 4);
    } finally {
      services.close();
    }
    let lateBuddyAcquisitions = 0;
    const closed = createNativeServices({
      session: {
        getBuddyService: () => {
          lateBuddyAcquisitions++;
          return buddy;
        },
        getUixConvertService: () => ({
          getUid: () =>
            new Promise((resolve) => {
              resolveUid = resolve;
            }),
        }),
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
      },
      version: profile.clientVersion,
      binaryProfile: profile,
      events: { emit() {} },
    });
    lateBuddyAcquisitions = 0;
    const beforeClosedCalls = calls;
    const pending = closed.invokeOperation('setFriendCategory', { userId: '123', categoryId: 1 });
    const rejected = assert.rejects(pending);
    await new Promise((resolve) => setImmediate(resolve));
    closed.close();
    await rejected;
    resolveUid({ uidInfo: new Map([['123', 'u_exact']]) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, beforeClosedCalls);
    assert.equal(lateBuddyAcquisitions, 0);
    /** @type {(error:Error)=>void} */
    let rejectNative = () => assert.fail('Native rejection latch missing');
    /** @type {()=>void} */
    let markDispatched = () => assert.fail('Dispatch latch missing');
    const dispatched = new Promise((resolve) => {
      markDispatched = () => resolve(undefined);
    });
    let pendingWrites = 0;
    const pendingBuddy = {
      addKernelBuddyListener() {},
      setBuddyCategory(/** @type {string} */ uid, /** @type {number} */ categoryId) {
        assert.equal(this, pendingBuddy);
        assert.deepEqual([uid, categoryId], ['u_exact', 1]);
        pendingWrites++;
        markDispatched();
        return new Promise((_, reject) => {
          rejectNative = reject;
        });
      },
    };
    const pendingServices = createNativeServices({
      session: {
        getBuddyService: () => pendingBuddy,
        getUixConvertService: () => ({
          getUid: () => ({ uidInfo: new Map([['123', 'u_exact']]) }),
        }),
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
      },
      version: profile.clientVersion,
      binaryProfile: profile,
      events: { emit() {} },
    });
    /** @type {unknown[]} */
    const unhandled = [];
    const onUnhandled = (/** @type {unknown} */ error) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      const mutation = pendingServices.invokeOperation('setFriendCategory', {
        userId: '123',
        categoryId: 1,
      });
      const unknownEffect = assert.rejects(mutation, /assignment; remote effect unknown/);
      await dispatched;
      pendingServices.close();
      await unknownEffect;
      rejectNative(new Error('late controlled mutation failure'));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      assert.equal(pendingWrites, 1);
    } finally {
      pendingServices.close();
      process.removeListener('unhandledRejection', onUnhandled);
    }
    const { terminateWorker } =
      await /** @type {Promise<typeof import('../../src/runtime/worker-termination.ts')>} */ (
        import(pathToFileURL(join(packageRoot, 'dist/runtime/worker-termination.js')).href)
      );
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'qq-assignment-worker-')));
    /** @type {import('node:child_process').ChildProcess|undefined} */
    let worker;
    /** @type {import('../../src/index.ts').QQClient|undefined} */
    let client;
    try {
      const kernelPath = await realpath(join(packageRoot, 'dist/kernel.js'));
      const nativePath = await realpath(join(packageRoot, 'dist/native-services.js'));
      await writeFile(join(directory, 'fixture.node'), 'synthetic wrapper; never loaded');
      const fixture = join(directory, 'kernel.mjs'),
        hook = join(directory, 'hook.mjs');
      await writeFile(
        fixture,
        `import {createNativeServices} from ${JSON.stringify(pathToFileURL(nativePath).href)};
export function createKernel(_n,_o,emit){let calls=0;const buddy={addKernelBuddyListener(){},setBuddyCategory(uid,id){if(this!==buddy||uid!=='u_exact'||id!==4294967295)throw Error('incorrect assignment dispatch');calls++;if(calls>2)throw Error('unexpected repeat');return {result:0};}};const services=createNativeServices({session:{getBuddyService:()=>buddy,getUixConvertService:()=>({getUid(/** @type {string[]} */ ids){if(ids.length!==1||ids[0]!=='000123')throw Error('incorrect UID query');return {uidInfo:new Map([['000123','u_exact']])};}}),getMsgService:()=>({addKernelMsgListener(){}}),getGroupService:()=>({addKernelGroupListener(){}})},version:${JSON.stringify(profile.clientVersion)},binaryProfile:${JSON.stringify(profile)},events:{emit(){}}});return {async prepare(){},async login(){const account={uin:'999',uid:'fixture'};emit('ready',account);return account;},invokeOperation(method,payload,signal){return services.invokeOperation(method,payload,signal);},async close(){services.close();}};}`,
      );
      await writeFile(
        hook,
        `import {registerHooks} from 'node:module';process.dlopen=()=>{};registerHooks({resolve(s,c,next){const r=next(s,c);if(r.url===${JSON.stringify(pathToFileURL(kernelPath).href)})return {url:${JSON.stringify(pathToFileURL(fixture).href)},shortCircuit:true};return r;}});`,
      );
      worker = fork(await realpath(join(packageRoot, 'dist/worker.js')), [], {
        cwd: directory,
        execArgv: ['--import', pathToFileURL(hook).href],
        serialization: 'advanced',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      worker.stdout?.resume();
      worker.stderr?.resume();
      client = new QQClient(worker, 3000);
      await client.request('init', {
        options: {
          dataDir: join(directory, 'account-unused'),
          wrapperPath: join(directory, 'fixture.node'),
          version: { clientVersion: profile.clientVersion, appId: 'fixture', qua: 'fixture' },
          preloadLibraries: [],
        },
      });
      await client.login({ method: 'restore', uin: '999' });
      const originalSend = worker.send;
      /** @type {{userId:unknown,categoryId:unknown}[]} */
      const assignmentMessages = [];
      const currentWorker = worker;
      Object.defineProperty(worker, 'send', {
        value: (
          /** @type {Parameters<import('node:child_process').ChildProcess['send']>} */ ...args
        ) => {
          const message = args[0];
          if (
            message &&
            typeof message === 'object' &&
            'method' in message &&
            message.method === 'setFriendCategory'
          ) {
            assert.ok('userId' in message && 'categoryId' in message);
            assignmentMessages.push({ userId: message.userId, categoryId: message.categoryId });
          }
          return Reflect.apply(originalSend, currentWorker, args);
        },
      });
      await client.setFriendCategory('000123', 0xffff_ffff);
      const command = await prepareCommand('friend-category-set', {
        target: '000123',
        'category-id': '4294967295',
      });
      await command(client);
      for (const id of ['-1', '1.5', '4294967296', 'abc'])
        await assert.rejects(
          prepareCommand('friend-category-set', { target: '000123', 'category-id': id }),
        );
      await assert.rejects(client.setFriendCategory('0', 1));
      assert.deepEqual(
        assignmentMessages.map(({ userId, categoryId }) => ({ userId, categoryId })),
        [
          { userId: '000123', categoryId: 0xffff_ffff },
          { userId: '000123', categoryId: 0xffff_ffff },
        ],
      );
      await client.close();
    } finally {
      try {
        await client?.close();
      } finally {
        try {
          if (worker) await terminateWorker(worker, { forceDelayMs: 100, deadlineMs: 1500 });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  }
  return {
    friendCategoryAssignmentBinaryGateContract: true,
    friendCategoryAssignmentLinuxMacCompositionContract: true,
    friendCategoryAssignmentSharedWorkerFixturePlatform: expectedProfiles
      .map(({ platform, arch }) => `${platform}/${arch}`)
      .join(','),
    friendCategoryAssignmentLinuxArmCompositionContract: true,
    friendCategoryAssignmentEnabledProfilesWorkerCliContract: true,
    friendCategoryAssignmentVerifiedProfileCount: expectedProfiles.length,
    friendCategoryAssignmentMalformedAckContract: true,
    friendCategoryAssignmentPostDispatchCloseContract: true,
    friendCategoryAssignmentLateUidNoAcquisitionContract: true,
    friendCategoryAssignmentCompositionContract: true,
    friendCategoryAssignmentFacadeContract: true,
    friendCategoryAssignmentCliContract: true,
    friendCategoryAssignmentActualWorkerRouteContract: true,
    friendCategoryAssignmentCloseContract: true,
    nativeFriendCategoryAssignmentAttempted: false,
  };
}
