import assert from 'node:assert/strict';
import { ChildProcess, fork } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Actual worker IPC with only the kernel and dlopen replaced by local fixtures.
 * @param {{QQClient:typeof import('../../src/index.ts').QQClient,workerPath:string,kernelPath:string}} context */
export async function verifyContactGroupWorkerRoutes({ QQClient, workerPath, kernelPath }) {
  workerPath = await realpath(workerPath);
  kernelPath = await realpath(kernelPath);
  const directory = await mkdtemp(join(tmpdir(), 'qq-contact-routes-'));
  const hook = join(directory, 'fixture-hook.mjs');
  await writeFile(
    hook,
    `import {registerHooks} from 'node:module';
process.dlopen = () => {};
registerHooks({load(url,context,next){
 if(url!==${JSON.stringify(pathToFileURL(kernelPath).href)})return next(url,context);
 return {format:'module',shortCircuit:true,source:\`export function createKernel(_native,_options,emit){if(_options.nativeContracts!==undefined)throw Error('Caller-provided native contract reached kernel');return {
  async prepare(){},async close(){},async login(){const account={uin:'123',uid:'u_fixture'};emit('ready',account);emit('friend-added',{uid:'u_fixture_friend',messageId:'9'});return account;},
  async invokeOperation(method,payload){if(method==='addFriendCategory')return {categoryId:8,name:payload.name};if(method==='listGroupMutedMembers')return [];if(method==='getGroupInfo')return {groupId:payload.groupId,name:'fixture',memberCount:0,maxMemberCount:200,ownerUid:'u_fixture',ownerUserId:'123',description:''};if(method==='listFriendCategories')return [{categoryId:1,sortId:0,name:'fixture',memberCount:0,onlineCount:0,friends:[]}];
   if(method==='getGroupEssencePage'){if(payload.groupId!=='123'||payload.options.pageStart!==17||payload.options.pageLimit!==2)throw Error('Invalid essence page IPC');return {...payload.options,groupId:payload.groupId,messages:[],isEnd:false,groupRole:2};}
   if(method==='listGroupEssenceMessages'){if(payload.groupId!=='123'||payload.options.maxPages!==2)throw Error('Invalid full essence IPC');return [];}
   if(method==='setGroupEssenceMessage'){if(payload.groupId!=='123'||payload.messageId!=='9876543210123456789'||typeof payload.enabled!=='boolean')throw Error('Invalid essence IPC intent');return;}
   if(method==='reorderFriendCategories'){if(JSON.stringify(payload.categories)!==JSON.stringify([{categoryId:4294967295,name:' exact 中文 '},{categoryId:0,name:''}]))throw Error('Invalid category order IPC');return;}
   if(method==='createGroupFolder'){if(payload.groupId!=='18446744073709551615'||payload.name!==' fixture folder ')throw Error('Invalid create folder IPC');return {groupId:payload.groupId,folderId:'opaque-new',parentFolderId:'',name:payload.name};}
   if(method==='deleteGroupFolder'){if(payload.groupId!=='18446744073709551615'||payload.folderId!==' opaque/文件夹 ')throw Error('Invalid folder IPC');return;}
   if(method==='getGroupFileCount'){if(payload.groupId!=='18446744073709551615')throw Error('Invalid file count IPC');return 4294967295;}
   if(method==='setGroupRemark')return {method,groupId:payload.groupId,remark:payload.remark};throw Error('Unexpected fixture operation');}
 };}\`};
}});
`,
  );
  const worker = fork(workerPath, [], {
    cwd: directory,
    execArgv: ['--import', pathToFileURL(hook).href],
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Drain child output without forwarding fixture paths into consumer output.
  worker.stdout?.resume();
  worker.stderr?.resume();
  const client = new QQClient(worker, 5000);
  try {
    await client.request('init', {
      options: {
        dataDir: join(directory, 'account'),
        wrapperPath: join(directory, 'fixture.node'),
        version: 'fixture',
        preloadLibraries: [],
        nativeContracts: {
          platform: 'darwin',
          arch: 'arm64',
          clientVersion: '7.0.2-53644',
          wrapperSha256: 'forged',
        },
      },
    });
    /** @type {import('../../src/contracts/contacts.ts').FriendAdded[]} */
    const friendNotices = [];
    client.on('friend-added', (notice) => friendNotices.push(notice));
    await client.login({ method: 'restore', uin: '123' });
    assert.deepEqual(friendNotices, [{ uid: 'u_fixture_friend', messageId: '9' }]);
    assert.deepEqual(await client.addFriendCategory(' 新分组 '), {
      categoryId: 8,
      name: ' 新分组 ',
    });
    assert.equal(
      await client.reorderFriendCategories([
        { categoryId: 0xffff_ffff, name: ' exact 中文 ' },
        { categoryId: 0, name: '' },
      ]),
      undefined,
    );
    assert.equal(
      await client.deleteGroupFolder('18446744073709551615', ' opaque/文件夹 '),
      undefined,
    );
    assert.deepEqual(await client.createGroupFolder('18446744073709551615', ' fixture folder '), {
      groupId: '18446744073709551615',
      folderId: 'opaque-new',
      parentFolderId: '',
      name: ' fixture folder ',
    });
    await assert.rejects(client.deleteGroupFolder('18446744073709551616', 'folder'), /uint64/);
    await assert.rejects(client.deleteGroupFolder('123', ''), /nonempty/);
    assert.equal(await client.getGroupFileCount('18446744073709551615'), 4294967295);
    await assert.rejects(client.getGroupFileCount('18446744073709551616'), /uint64/);
    await assert.rejects(client.getGroupFileCount('0'), /group identifier/);
    await assert.rejects(client.addFriendCategory(' '), /nonblank/);
    assert.deepEqual(await client.listGroupMutedMembers('000123'), []);
    assert.equal((await client.getGroupInfo('000123')).groupId, '000123');
    assert.deepEqual(await client.listFriendCategories(), [
      { categoryId: 1, sortId: 0, name: 'fixture', memberCount: 0, onlineCount: 0, friends: [] },
    ]);
    assert.deepEqual(await client.setGroupRemark('000123', ''), {
      method: 'setGroupRemark',
      groupId: '000123',
      remark: '',
    });
    assert.deepEqual(await client.getGroupEssencePage('123', { pageStart: 17, pageLimit: 2 }), {
      groupId: '123',
      pageStart: 17,
      pageLimit: 2,
      messages: [],
      isEnd: false,
      groupRole: 2,
    });
    await assert.rejects(client.getGroupEssencePage('123', { pageLimit: 51 }), /pageLimit/);
    const listOptions = { maxPages: 2 };
    const fullList = client.listGroupEssenceMessages('123', listOptions);
    listOptions.maxPages = 999;
    assert.deepEqual(await fullList, []);
    await assert.rejects(client.listGroupEssenceMessages('123', { maxPages: 0 }), /maxPages/);
    for (const enabled of [true, false])
      assert.equal(
        await client.setGroupEssenceMessage('123', '9876543210123456789', enabled),
        undefined,
      );
    await assert.rejects(
      client.setGroupEssenceMessage('0', '9876543210123456789', true),
      /group identifier/,
    );
  } finally {
    try {
      await client.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return {
    contactGroupActualWorkerRoutes: true,
    groupFileCountActualWorkerRoute: true,
    groupEssenceFullActualWorkerRoute: true,
    kernelReplacedByFixture: true,
    nativeExecuted: false,
    accountUsed: false,
  };
}

/** @param {string} packageRoot */
export async function verifyContactGroupConsumer(packageRoot) {
  const { QQClient } = await /** @type {Promise<typeof import('../../src/index.ts')>} */ (
    import(pathToFileURL(join(packageRoot, 'dist/index.js')).href)
  );
  const { prepareCommand, observeWatchEvents } =
    await /** @type {Promise<typeof import('../../src/cli.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/cli.js')).href)
    );
  const { createGroupEvents, createGroupEventIngress } =
    await /** @type {Promise<typeof import('../../src/features/groups/group-events.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/features/groups/group-events.js')).href)
    );
  // Exercise the installed ingress owner rather than reproducing composition ordering.
  {
    /** @type {unknown[]} */
    const order = [];
    const raw = [{ groupCode: '123', groupName: 'fixture' }];
    const detail = {
      groupCode: '123',
      groupName: 'fixture',
      memberNum: 0,
      maxMemberNum: 200,
      ownerUid: 'u_owner',
      ownerUin: '456',
      fingerMemo: '',
    };
    let trace = true;
    let traceReads = 0;
    const ingress = createGroupEventIngress({
      emit(event) {
        order.push(event);
      },
      dispatchList(kind, groups) {
        assert.equal(kind, 2);
        assert.strictEqual(groups, raw);
        order.push('raw-list');
      },
      dispatchDetail(value) {
        assert.strictEqual(value, detail);
        order.push('raw-detail');
      },
      traceEnabled() {
        traceReads++;
        return trace;
      },
    });
    ingress.onGroupListUpdate(2, raw);
    assert.deepEqual(order, ['diagnostic', 'group-list-updated', 'raw-list']);
    order.length = 0;
    trace = false;
    ingress.onGroupListUpdate(2, raw);
    assert.deepEqual(order, ['group-list-updated', 'raw-list']);
    assert.equal(traceReads, 2);
    order.length = 0;
    ingress.onGroupDetailInfoChange(detail);
    assert.deepEqual(order, ['group-info-updated', 'raw-detail']);
    /** @type {unknown[]} */
    const invalidOrder = [];
    const invalidRaw = [{ groupCode: '123' }, { groupCode: '456', groupName: 7 }];
    const invalid = createGroupEventIngress({
      emit(event) {
        invalidOrder.push(event);
      },
      dispatchList(_kind, groups) {
        assert.strictEqual(groups, invalidRaw);
        invalidOrder.push('raw');
      },
      dispatchDetail() {
        assert.fail('Unexpected detail dispatch');
      },
      traceEnabled() {
        return false;
      },
    });
    invalid.onGroupListUpdate(2, invalidRaw);
    assert.deepEqual(invalidOrder, ['diagnostic', 'raw']);
    const original = Error('controlled observer failure');
    let dispatches = 0;
    const throwing = createGroupEventIngress({
      emit() {
        throw original;
      },
      dispatchList() {
        dispatches++;
      },
      dispatchDetail() {
        dispatches++;
      },
      traceEnabled() {
        return false;
      },
    });
    assert.throws(
      () => throwing.onGroupListUpdate(2, raw),
      (error) => error === original,
    );
    assert.throws(
      () => throwing.onGroupDetailInfoChange(detail),
      (error) => error === original,
    );
    assert.equal(dispatches, 0);
  }
  const { EventEmitter } = await import('node:events');
  const facadeWorker = new ChildProcess();
  Object.defineProperty(facadeWorker, 'exitCode', { value: 0, configurable: true });
  const facade = new QQClient(facadeWorker, 5000);
  facadeWorker.emit('exit', 0, null);
  try {
    /** @type {unknown[]} */
    const calls = [];
    facade.listGroupMutedMembers = async (id) => {
      calls.push(['muted', id]);
      return [];
    };
    await (
      await prepareCommand('group-muted', { 'group-id': '123' })
    )(facade);
    facade.getGroupInfo = async (id) => {
      calls.push(['info', id]);
      return {
        groupId: id,
        name: 'fixture',
        memberCount: 0,
        maxMemberCount: 200,
        ownerUid: 'u_fixture',
        ownerUserId: '123',
        description: '',
      };
    };
    await (
      await prepareCommand('group-info', { 'group-id': '123' })
    )(facade);
    facade.addFriendCategory = async (name) => {
      calls.push(['add-category', name]);
      return { categoryId: 8, name };
    };
    await (
      await prepareCommand('friend-category-add', { name: ' 新分组 ' })
    )(facade);
    await assert.rejects(prepareCommand('friend-category-add', { name: ' ' }), /blank/);
    facade.listFriendCategories = async () => {
      calls.push('categories');
      return [];
    };
    await (
      await prepareCommand('friend-categories', {})
    )(facade);
    facade.setGroupRemark = async (...args) => {
      calls.push(args);
    };
    await (
      await prepareCommand('group-remark', { 'group-id': '123', remark: '' })
    )(facade);
    facade.setGroupEssenceMessage = async (...args) => {
      calls.push(args);
    };
    await (
      await prepareCommand('group-essence', {
        'group-id': '123',
        'message-id': '9876543210123456789',
        enabled: 'false',
      })
    )(facade);
    assert.deepEqual(calls, [
      ['muted', '123'],
      ['info', '123'],
      ['add-category', ' 新分组 '],
      'categories',
      ['123', ''],
      ['123', '9876543210123456789', false],
    ]);
    const events = facade;
    /** @type {{event:string,payload:Record<string,unknown>}[]} */
    const lines = [];
    const lastLine = () => {
      const line = lines.at(-1);
      assert.ok(line);
      return line;
    };
    /** @param {string} line */
    const parseLine = (line) => {
      /** @type {unknown} */
      const value = JSON.parse(line);
      assert.ok(
        value &&
          typeof value === 'object' &&
          'event' in value &&
          typeof value.event === 'string' &&
          'payload' in value &&
          value.payload &&
          typeof value.payload === 'object',
      );
      return { event: value.event, payload: /** @type {Record<string,unknown>} */ (value.payload) };
    };
    const stop = observeWatchEvents(events, 'normalized', (line) => lines.push(parseLine(line)));
    const listener = createGroupEvents((name, payload) =>
      EventEmitter.prototype.emit.call(events, name, payload),
    );
    listener.onGroupDetailInfoChange({
      groupCode: '123',
      groupName: '',
      memberNum: 0,
      maxMemberNum: 200,
      ownerUid: 'u_owner',
      ownerUin: '456',
      fingerMemo: '',
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, 'group-info-updated');
    let eventNameReads = 0;
    listener.onGroupListUpdate(2, [
      {
        groupCode: '123',
        get groupName() {
          return ++eventNameReads === 1 ? 'captured' : 123;
        },
      },
    ]);
    assert.equal(eventNameReads, 1);
    assert.deepEqual(lastLine().payload, {
      kind: 'modified',
      groups: [{ groupId: '123', name: 'captured' }],
    });
    let eventRoleReads = 0;
    const eventMembers = new Map([
      [
        'u_snapshot',
        {
          get role() {
            return ++eventRoleReads === 1 ? 3 : 4;
          },
        },
      ],
    ]);
    Object.defineProperty(eventMembers, Symbol.iterator, {
      value() {
        throw Error('Overridden member iterator must not run');
      },
    });
    listener.onMemberInfoChange('123', 1, eventMembers);
    assert.equal(eventRoleReads, 1);
    assert.deepEqual(lastLine().payload, {
      groupId: '123',
      source: 'remote',
      members: [{ uid: 'u_snapshot', role: 'admin' }],
    });
    /** @type {[string,unknown][]} */
    const boundedDiagnostics = [];
    const throwingEvents = createGroupEvents((name, value) =>
      boundedDiagnostics.push([name, value]),
    );
    assert.doesNotThrow(() =>
      throwingEvents.onGroupListUpdate(2, [
        { groupCode: '123' },
        {
          groupCode: '456',
          get groupName() {
            throw Error('private projection fixture');
          },
        },
      ]),
    );
    assert.deepEqual(boundedDiagnostics, [
      ['diagnostic', { stage: 'invalid-native-group-list-update' }],
    ]);
    const { createGroupSystemEvents } =
      await /** @type {Promise<typeof import('../../src/features/groups/group-system-events.ts')>} */ (
        import(pathToFileURL(join(packageRoot, 'dist/features/groups/group-system-events.js')).href)
      );
    const membership = createGroupSystemEvents((name, payload) =>
      EventEmitter.prototype.emit.call(events, name, payload),
    );
    membership.onRecvSysMsg([18, 2, 8, 34, 26, 7, 18, 5, 8, 123, 32, 130, 1]);
    // Valid envelope with an absent subject; no identity fields are invented.
    assert.equal(lastLine().event, 'group-membership');
    assert.equal(lastLine().payload.kind, 'leave');
    membership.onRecvSysMsg([18, 2, 8, 44, 26, 11, 18, 9, 8, 123, 34, 5, 18, 3, 10, 1, 117]);
    assert.equal(lastLine().event, 'group-admin');
    assert.equal(lastLine().payload.memberUid, 'u');
    membership.onRecvMsg([
      {
        msgId: '1',
        chatType: 2,
        msgType: 5,
        peerUid: '123',
        elements: [
          {
            grayTipElement: {
              subElementType: 4,
              groupElement: {
                type: 8,
                shutUp: { duration: '0', admin: { uid: 'u_admin' }, member: { uid: '' } },
              },
            },
          },
        ],
      },
    ]);
    assert.equal(lastLine().event, 'group-mute');
    assert.equal(lastLine().payload.scope, 'all');

    /** @type {Parameters<import('../../src/index.ts').QQClient['deleteGroupFolder']>[]} */
    const folderCliCalls = [];
    facade.deleteGroupFolder = async (...args) => {
      folderCliCalls.push(args);
    };
    await (
      await prepareCommand('group-folder-delete', {
        'group-id': '18446744073709551615',
        'folder-id': ' opaque/文件夹 ',
      })
    )(facade);
    assert.deepEqual(folderCliCalls, [['18446744073709551615', ' opaque/文件夹 ']]);
    await assert.rejects(
      prepareCommand('group-folder-delete', {
        'group-id': '18446744073709551616',
        'folder-id': 'folder',
      }),
      /uint64/,
    );
    await assert.rejects(
      prepareCommand('group-folder-delete', { 'group-id': '123', 'folder-id': '' }),
      /nonempty|required/,
    );
    const { deleteGroupFolder } =
      await /** @type {Promise<typeof import('../../src/features/groups/group-file-operations.ts')>} */ (
        import(
          pathToFileURL(join(packageRoot, 'dist/features/groups/group-file-operations.js')).href
        )
      );
    for (const [response, code] of [
      [{ result: 0, groupFileCommonResult: { retCode: 0 } }, undefined],
      [{ result: 23, groupFileCommonResult: { retCode: 0 } }, 23],
      [{ result: 0, groupFileCommonResult: { retCode: -1 } }, -1],
      [{ result: 0 }, 'invalid-result'],
      [{ result: '0', groupFileCommonResult: { retCode: 0 } }, 'invalid-result'],
    ]) {
      const controller = new AbortController();
      let calls = 0;
      const service = {
        deleteGroupFolder(/** @type {string} */ group, /** @type {string} */ folder) {
          assert.equal(this, service);
          assert.equal(group, '18446744073709551615');
          assert.equal(folder, ' opaque/文件夹 ');
          calls++;
          return Promise.resolve(response);
        },
      };
      /** @type {Parameters<typeof deleteGroupFolder>[0]} */
      const context = {
        signal: controller.signal,
        getRichMediaService: () => service,
        awaitAlive: async (value) => value,
      };
      const operation = deleteGroupFolder(context, '18446744073709551615', ' opaque/文件夹 ');
      if (code === undefined) assert.equal(await operation, undefined);
      else await assert.rejects(operation, { code });
      assert.equal(calls, 1);
      controller.abort();
      await assert.rejects(deleteGroupFolder(context, '123', 'folder'));
      assert.equal(calls, 1, 'close gate must prevent a second dispatch');
    }
    const { createNativeServices } =
      await /** @type {Promise<typeof import('../../src/native-services.ts')>} */ (
        import(pathToFileURL(join(packageRoot, 'dist/native-services.js')).href)
      );
    // Exercise the installed composition, not just the source projector: native
    // accessors must never publish or cache a different value after validation.
    const capturedMember = {
      uid: 'u_snapshot',
      uin: '456',
      nick: 'snapshot',
      cardName: 'card',
      role: 2,
    };
    let cardReads = 0;
    Object.defineProperty(capturedMember, 'cardName', {
      get: () => (++cardReads === 1 ? 'card' : 123),
    });
    const nativeMembers = new Map([['u_snapshot', capturedMember]]);
    Object.defineProperty(nativeMembers, 'entries', {
      value() {
        throw Error('Overridden Map iterator must not run');
      },
    });
    const capturedGroup = {
      groupCode: '123',
      groupName: 'snapshot',
      memberCount: 1,
      maxMember: 200,
    };
    let nameReads = 0;
    Object.defineProperty(capturedGroup, 'groupName', {
      get: () => (++nameReads === 1 ? 'snapshot' : 123),
    });
    const groupSnapshots = createNativeServices({
      version: '7.0.2-53644',
      events: { emit() {} },
      session: {
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => ({
          addKernelGroupListener() {},
          getAllMemberList() {
            return { errCode: 0, result: { finish: true, infos: nativeMembers } };
          },
        }),
      },
    });
    try {
      assert.deepEqual(
        await groupSnapshots.invokeOperation('getGroupMembers', { groupId: '123' }),
        [{ userId: '456', uid: 'u_snapshot', nickname: 'snapshot', card: 'card', role: 'member' }],
      );
      assert.equal(cardReads, 1);
    } finally {
      groupSnapshots.close();
    }
    // Full-list projection uses the installed query owner and real callback
    // channel. Metadata events have a separate projection contract.
    const { createGroupQueries } =
      await /** @type {Promise<typeof import('../../src/features/groups/group-queries.ts')>} */ (
        import(pathToFileURL(join(packageRoot, 'dist/features/groups/group-queries.js')).href)
      );
    const { createNativeEventChannel } =
      await /** @type {Promise<typeof import('../../src/runtime/native-event-channel.ts')>} */ (
        import(pathToFileURL(join(packageRoot, 'dist/runtime/native-event-channel.js')).href)
      );
    const groupSignal = new AbortController().signal;
    const groupChannel = createNativeEventChannel(groupSignal);
    const groupQueries = createGroupQueries({
      signal: groupSignal,
      getGroupService: () => ({
        getGroupList() {
          groupChannel.dispatch('Group/onGroupListUpdate', [0, [capturedGroup]]);
          return { result: 0 };
        },
      }),
      eventCall: groupChannel.call,
      awaitAlive: async (value) => value,
      commitMembers() {},
    });
    try {
      assert.deepEqual(await groupQueries.listGroups(), [
        { groupId: '123', name: 'snapshot', memberCount: 1, maxMemberCount: 200 },
      ]);
      assert.equal(nameReads, 1);
    } finally {
      groupQueries.close();
      groupChannel.close();
    }
    const folderProfiles = [
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
        platform: 'darwin',
        arch: 'x64',
        clientVersion: '7.0.2-53644',
        wrapperSha256: 'e91c58872d3d498f2d3ac1c304ab3ae4602d016274cf3e0f0cb651ad765f1f54',
      },
      {
        platform: 'win32',
        arch: 'x64',
        clientVersion: '9.9.33-52230',
        wrapperSha256: '63112ab9161e127f5f7e17998a7196e143808923fb54cbbf7b4e21426187a5f0',
      },
      {
        platform: 'win32',
        arch: 'arm64',
        clientVersion: '9.9.33-52230',
        wrapperSha256: '54e5a6ce127a1f973f28e38ddfbf1338403ea323a141546a6578dd25332c928a',
      },
    ];
    let folderDispatches = 0;
    const folderServices = createNativeServices({
      version: folderProfiles[2].clientVersion,
      binaryProfile: folderProfiles[2],
      events: { emit() {} },
      session: {
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {}, removeKernelBuddyListener() {} }),
        getRichMediaService: () => ({
          deleteGroupFolder() {
            folderDispatches++;
            return new Promise(() => {});
          },
        }),
      },
    });
    const pendingFolder = assert.rejects(
      folderServices.invokeOperation('deleteGroupFolder', { groupId: '123', folderId: 'opaque' }),
    );
    folderServices.close();
    let watchdog;
    try {
      await Promise.race([
        pendingFolder,
        new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(Error('Folder close did not settle')), 1000);
        }),
      ]);
    } finally {
      clearTimeout(watchdog);
    }
    await assert.rejects(
      folderServices.invokeOperation('deleteGroupFolder', { groupId: '123', folderId: 'opaque' }),
    );
    assert.equal(folderDispatches, 1);

    for (const profile of folderProfiles) {
      for (const supplied of [
        profile,
        undefined,
        { ...profile, platform: 'unsupported' },
        { ...profile, arch: 'unsupported' },
        { ...profile, clientVersion: 'unknown' },
        { ...profile, wrapperSha256: '0'.repeat(64) },
      ]) {
        let gets = 0,
          calls = 0;
        const guarded = createNativeServices({
          version: profile.clientVersion,
          binaryProfile: supplied,
          events: { emit() {} },
          session: {
            getMsgService: () => ({ addKernelMsgListener() {} }),
            getBuddyService: () => ({ addKernelBuddyListener() {} }),
            getGroupService: () => ({ addKernelGroupListener() {} }),
            getRichMediaService() {
              gets++;
              return {
                deleteGroupFolder() {
                  calls++;
                  return { result: 0, groupFileCommonResult: { retCode: 0 } };
                },
              };
            },
          },
        });
        try {
          if (supplied === profile)
            await guarded.invokeOperation('deleteGroupFolder', {
              groupId: '18446744073709551615',
              folderId: ' opaque ',
            });
          else
            await assert.rejects(
              guarded.invokeOperation('deleteGroupFolder', { groupId: '123', folderId: 'opaque' }),
            );
          assert.equal(gets, supplied === profile ? 1 : 0);
          assert.equal(calls, supplied === profile ? 1 : 0);
        } finally {
          guarded.close();
        }
      }
    }
    const createdRaw = () => ({
      result: 0,
      resultWithGroupItem: {
        result: { retCode: 0 },
        groupItem: {
          peerId: '00123',
          folderInfo: {
            folderId: 'opaque-created',
            parentFolderId: '',
            folderName: ' fixture folder ',
          },
        },
      },
    });
    for (const profile of folderProfiles) {
      for (const supplied of [
        profile,
        undefined,
        { ...profile, platform: 'unsupported' },
        { ...profile, arch: 'unsupported' },
        { ...profile, clientVersion: 'unknown' },
        { ...profile, wrapperSha256: '0'.repeat(64) },
      ]) {
        let gets = 0,
          creates = 0,
          deletes = 0;
        /** @type {NonNullable<ReturnType<import('../../src/features/groups/group-file-operations.ts').GroupFileContext['getRichMediaService']>> & NonNullable<ReturnType<import('../../src/features/groups/group-file-operations.ts').GroupFolderCreationContext['getRichMediaService']>>} */
        const media = {
          createGroupFolder(group, name) {
            assert.equal(this, media);
            assert.deepEqual([group, name], ['00123', ' fixture folder ']);
            creates++;
            return createdRaw();
          },
          deleteGroupFolder(group, id) {
            assert.deepEqual([group, id], ['00123', 'opaque-created']);
            deletes++;
            return { result: 0, groupFileCommonResult: { retCode: 0 } };
          },
        };
        const composition = createNativeServices({
          version: profile.clientVersion,
          binaryProfile: supplied,
          events: { emit() {} },
          session: {
            getMsgService: () => ({ addKernelMsgListener() {} }),
            getBuddyService: () => ({ addKernelBuddyListener() {} }),
            getGroupService: () => ({ addKernelGroupListener() {} }),
            getRichMediaService() {
              gets++;
              return media;
            },
          },
        });
        try {
          if (supplied === profile) {
            const folder = await composition.invokeOperation('createGroupFolder', {
              groupId: '00123',
              name: ' fixture folder ',
            });
            assert.deepEqual(folder, {
              groupId: '00123',
              folderId: 'opaque-created',
              parentFolderId: '',
              name: ' fixture folder ',
            });
            assert.ok(
              folder && typeof folder === 'object' && 'groupId' in folder && 'folderId' in folder,
            );
            await composition.invokeOperation('deleteGroupFolder', {
              groupId: folder.groupId,
              folderId: folder.folderId,
            });
            assert.equal(creates, 1);
            assert.equal(deletes, 1);
          } else {
            await assert.rejects(
              composition.invokeOperation('createGroupFolder', {
                groupId: '00123',
                name: ' fixture folder ',
              }),
            );
            assert.equal(gets, 0);
            assert.equal(creates, 0);
          }
        } finally {
          composition.close();
        }
      }
    }
    const { createGroupFolder } =
      await /** @type {Promise<typeof import('../../src/features/groups/group-file-operations.ts')>} */ (
        import(
          pathToFileURL(join(packageRoot, 'dist/features/groups/group-file-operations.js')).href
        )
      );
    for (const response of [
      { result: 23 },
      { result: 0, resultWithGroupItem: { result: { retCode: 42 } } },
      { ...createdRaw(), resultWithGroupItem: { result: { retCode: 0 }, groupItem: Array(1) } },
      {
        result: 0,
        resultWithGroupItem: {
          result: { retCode: 0 },
          groupItem: {
            peerId: '124',
            folderInfo: createdRaw().resultWithGroupItem.groupItem.folderInfo,
          },
        },
      },
      { result: 0, resultWithGroupItem: { result: { retCode: 0 }, groupItem: { peerId: '123' } } },
    ]) {
      const controller = new AbortController();
      let calls = 0;
      await assert.rejects(
        createGroupFolder(
          {
            signal: controller.signal,
            awaitAlive: async (value) => value,
            getRichMediaService: () => ({
              createGroupFolder() {
                calls++;
                return response;
              },
            }),
          },
          '00123',
          ' fixture folder ',
        ),
      );
      assert.equal(calls, 1);
    }
    const { NativeServiceLifetime: CreateLifetime } =
      await /** @type {Promise<typeof import('../../src/runtime/native-service-lifetime.ts')>} */ (
        import(pathToFileURL(join(packageRoot, 'dist/runtime/native-service-lifetime.js')).href)
      );
    const createLifetime = new CreateLifetime();
    let createCalls = 0;
    /** @type {(reason:unknown)=>void} */
    let lateReject = () => assert.fail('Late rejecter missing');
    const lateCompletion = new Promise((_, reject) => {
      lateReject = reject;
    });
    const canceledCreate = assert.rejects(
      createGroupFolder(
        {
          signal: createLifetime.signal,
          awaitAlive: createLifetime.awaitAlive,
          getRichMediaService: () => ({
            createGroupFolder() {
              createCalls++;
              return lateCompletion;
            },
          }),
        },
        '00123',
        ' fixture folder ',
      ),
    );
    createLifetime.close();
    await canceledCreate;
    lateReject(Error('late create acknowledgement'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(createCalls, 1);
    const createPlan = await prepareCommand('group-folder-create', {
      'group-id': '00123',
      name: ' fixture folder ',
    });
    /** @type {Parameters<import('../../src/index.ts').QQClient['createGroupFolder']>[]} */
    const createCliCalls = [];
    facade.createGroupFolder = async (...args) => {
      createCliCalls.push(args);
      return { groupId: args[0], folderId: 'opaque-cli', parentFolderId: '', name: args[1] };
    };
    assert.deepEqual(await createPlan(facade), {
      groupId: '00123',
      folderId: 'opaque-cli',
      parentFolderId: '',
      name: ' fixture folder ',
    });
    assert.deepEqual(createCliCalls, [['00123', ' fixture folder ']]);
    await assert.rejects(prepareCommand('group-folder-create', { 'group-id': '123', name: ' ' }));
    /** @type {{onRecvMsg(value:unknown):void}|undefined} */
    let compiledMsg;
    /** @type {{onShutUpMemberListChanged(id:unknown,value:unknown):void}[]} */
    const groupListeners = [];
    /** @type {unknown[][]} */
    const essenceCalls = [];
    const compiledServices = createNativeServices({
      session: {
        getMsgService: () => ({
          addKernelMsgListener(/** @type {NonNullable<typeof compiledMsg>} */ value) {
            compiledMsg = value;
          },
          getMsgsByMsgId(
            /** @type {import('../../src/native/message-contracts.ts').NativePeer} */ peer,
            /** @type {string[]} */ ids,
          ) {
            assert.deepEqual(peer, { chatType: 2, peerUid: '123' });
            assert.deepEqual(ids, ['9876543210123456789']);
            return {
              result: 0,
              msgList: [
                {
                  chatType: 2,
                  peerUid: '123',
                  msgId: ids[0],
                  msgSeq: '9',
                  msgRandom: '4294967295',
                  elements: [],
                },
              ],
            };
          },
        }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => ({
          addKernelGroupListener(/** @type {typeof groupListeners[number]} */ value) {
            groupListeners.push(value);
          },
          getGroupShutUpMemberList(/** @type {string} */ id) {
            for (const listener of groupListeners) listener.onShutUpMemberListChanged(id, []);
            return { result: 0 };
          },
          addGroupEssence(
            /** @type {{groupCode:string,msgSeq:number,msgRandom:number}} */ request,
          ) {
            essenceCalls.push(['add', request]);
            return { errCode: 0, result: { errorCode: 0 } };
          },
          removeGroupEssence(
            /** @type {{groupCode:string,msgSeq:number,msgRandom:number}} */ request,
          ) {
            essenceCalls.push(['remove', request]);
            return { errCode: 0, result: { errorCode: 8, wording: 'must not be serialized' } };
          },
        }),
      },
      version: '7.0.2-53644',
      events: {
        emit: (/** @type {string} */ name, /** @type {unknown} */ value) =>
          EventEmitter.prototype.emit.call(events, name, value),
      },
    });
    try {
      assert.ok(compiledMsg);
      compiledMsg.onRecvMsg([
        {
          msgId: '9',
          chatType: 1,
          msgType: 5,
          peerUid: 'u_fixture_friend',
          peerUin: '900719925474099312345',
          elements: [
            { grayTipElement: { subElementType: 17, jsonGrayTipElement: { busiId: '19324' } } },
          ],
        },
      ]);
      assert.deepEqual(lines.at(-1), {
        event: 'friend-added',
        payload: { uid: 'u_fixture_friend', messageId: '9', userId: '900719925474099312345' },
      });
      assert.deepEqual(
        await compiledServices.invokeOperation('listGroupMutedMembers', { groupId: '123' }),
        [],
      );
      const intent = { groupId: '123', messageId: '9876543210123456789' };
      await compiledServices.invokeOperation('setGroupEssenceMessage', {
        ...intent,
        enabled: true,
      });
      await assert.rejects(
        compiledServices.invokeOperation('setGroupEssenceMessage', { ...intent, enabled: false }),
        (error) => {
          assert.ok(error instanceof Error && 'code' in error);
          return error.code === 8 && !error.message.includes('must not');
        },
      );
      assert.deepEqual(essenceCalls, [
        ['add', { groupCode: '123', msgSeq: 9, msgRandom: 4294967295 }],
        ['remove', { groupCode: '123', msgSeq: 9, msgRandom: 4294967295 }],
      ]);
    } finally {
      compiledServices.close();
    }
    const { getGroupEssencePage } =
      await /** @type {Promise<typeof import('../../src/features/groups/group-essence-list.ts')>} */ (
        import(pathToFileURL(join(packageRoot, 'dist/features/groups/group-essence-list.js')).href)
      );
    /** @type {URL[]} */
    const pageRequests = [];
    const page = await getGroupEssencePage(
      {
        getTicketService: () => ({
          forceFetchClientKey: async () => ({ result: 0, clientKey: 'synthetic-installed-ticket' }),
        }),
        getTipOffService: () => undefined,
        signal: new AbortController().signal,
        awaitAlive: async (value) => value,
        accountId: '123',
        fetchImpl: async (url) => {
          pageRequests.push(new URL(url instanceof Request ? url.url : url));
          if (pageRequests.length === 1) {
            const headers = new Headers();
            headers.append('set-cookie', 'skey=abc; Path=/');
            headers.append('set-cookie', 'p_skey=synthetic-installed-domain; Path=/');
            return new Response(null, { headers });
          }
          return Response.json({
            retcode: 0,
            data: {
              msg_list: [],
              is_end: false,
              group_role: 2,
              config_page_url: 'synthetic-private',
            },
          });
        },
      },
      '123',
      { pageStart: 17, pageLimit: 2 },
    );
    assert.equal(page.isEnd, false);
    assert.equal(pageRequests.length, 2);
    assert.equal(pageRequests[1].pathname, '/cgi-bin/group_digest/digest_list');
    assert.equal(pageRequests[1].searchParams.get('page_start'), '17');
    assert.equal(JSON.stringify(page).includes('synthetic-'), false);
    /** @type {Parameters<import('../../src/index.ts').QQClient['getGroupEssencePage']>[]} */
    const listCalls = [];
    facade.getGroupEssencePage = async (...args) => {
      listCalls.push(args);
      return page;
    };
    await (
      await prepareCommand('group-essence-list', {
        'group-id': '123',
        'page-start': '17',
        'page-limit': '2',
      })
    )(facade);
    assert.deepEqual(listCalls, [['123', { pageStart: 17, pageLimit: 2 }]]);
    const categoryProfile = {
      platform: 'darwin',
      arch: 'arm64',
      clientVersion: '7.0.2-53644',
      wrapperSha256: 'fbc8ad9b328d05e16784d76b0181dda894c17001179dbf8c0d5dd00dc6271358',
    };
    /** @type {unknown[][]} */
    const categoryCalls = [];
    let categoryMethodReads = 0;
    let closeDuringCategoryAcquisition = false;
    const categoryBuddy = {
      addKernelBuddyListener() {},
      get addCategoryV2() {
        categoryMethodReads++;
        if (closeDuringCategoryAcquisition) categoryServices.close();
        return /** @this {object} @param {[string,undefined]} args */ function (...args) {
          assert.equal(this, categoryBuddy);
          categoryCalls.push(args);
          return { result: 0, groupId: 8, name: 'native' };
        };
      },
    };
    const categoryServices = createNativeServices({
      session: {
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getBuddyService: () => categoryBuddy,
      },
      version: '7.0.2-53644',
      events: { emit: () => {} },
      binaryProfile: categoryProfile,
    });
    try {
      assert.deepEqual(
        await categoryServices.invokeOperation('addFriendCategory', { name: ' 新分组 ' }),
        { categoryId: 8, name: 'native' },
      );
      assert.deepEqual(categoryCalls, [[' 新分组 ', undefined]]);
      assert.equal(categoryMethodReads, 1);
      closeDuringCategoryAcquisition = true;
      await assert.rejects(
        categoryServices.invokeOperation('addFriendCategory', { name: 'closed' }),
        { name: 'AbortError' },
      );
      assert.equal(categoryMethodReads, 2);
      assert.equal(categoryCalls.length, 1);
    } finally {
      categoryServices.close();
    }
    /** @type {string[]} */
    const countCalls = [];
    const countPlan = await prepareCommand('group-file-count', { 'group-id': '000123' });
    facade.getGroupFileCount = async (group) => {
      countCalls.push(group);
      return 0;
    };
    assert.equal(await countPlan(facade), 0);
    assert.deepEqual(countCalls, ['000123']);
    await assert.rejects(
      prepareCommand('group-file-count', { 'group-id': '18446744073709551616' }),
      /uint64/,
    );
    await assert.rejects(prepareCommand('group-file-count', { 'group-id': '0' }));
    /** @param {unknown} response
     * @param {import('../../src/native/native-contracts.ts').NativeContractProfile} [profile] */
    const countFixture = (response, profile = categoryProfile) => {
      let acquisitions = 0,
        dispatches = 0;
      const native = {
        batchGetGroupFileCount(/** @type {string[]} */ groups) {
          assert.equal(this, native);
          assert.deepEqual(groups, ['000123']);
          dispatches++;
          return response;
        },
      };
      const services = createNativeServices({
        version: categoryProfile.clientVersion,
        binaryProfile: profile,
        events: { emit() {} },
        session: {
          getMsgService: () => ({ addKernelMsgListener() {} }),
          getGroupService: () => ({ addKernelGroupListener() {} }),
          getBuddyService: () => ({ addKernelBuddyListener() {}, removeKernelBuddyListener() {} }),
          getRichMediaService: () => {
            acquisitions++;
            return native;
          },
        },
      });
      return { services, acquisitions: () => acquisitions, dispatches: () => dispatches };
    };
    for (const [response, expectedCode] of [
      [{ result: 0, groupCodes: ['123'], groupFileCounts: [4294967295] }, undefined],
      [{ result: -7, errMsg: 'PRIVATE' }, -7],
      [{ result: '0', groupCodes: ['123'], groupFileCounts: [0] }, 'invalid-result'],
      [{ result: 0, groupCodes: ['456'], groupFileCounts: [1] }, 'invalid-result'],
      [{ result: 0, groupCodes: ['123'], groupFileCounts: [] }, 'invalid-result'],
      [{ result: 0, groupCodes: ['123'], groupFileCounts: [-1] }, 'invalid-result'],
    ]) {
      const f = countFixture(response);
      try {
        assert.equal(f.acquisitions(), 0, 'service selection must remain lazy');
        const pending = f.services.invokeOperation('getGroupFileCount', { groupId: '000123' });
        if (expectedCode === undefined) assert.equal(await pending, 4294967295);
        else
          await assert.rejects(pending, (error) => {
            assert.ok(error instanceof Error && 'code' in error);
            return error.code === expectedCode && !error.message.includes('PRIVATE');
          });
        assert.equal(f.dispatches(), 1);
      } finally {
        f.services.close();
      }
    }
    const unknown = countFixture({}, { ...categoryProfile, wrapperSha256: 'unverified' });
    try {
      await assert.rejects(
        unknown.services.invokeOperation('getGroupFileCount', { groupId: '000123' }),
      );
      assert.equal(unknown.acquisitions(), 0);
    } finally {
      unknown.services.close();
    }
    /** @type {(reason:unknown)=>void} */
    let rejectLate = () => assert.fail('Late rejecter missing');
    const closing = countFixture(
      new Promise((_, reject) => {
        rejectLate = reject;
      }),
    );
    const pendingCount = assert.rejects(
      closing.services.invokeOperation('getGroupFileCount', { groupId: '000123' }),
    );
    closing.services.close();
    rejectLate(Error('late count failure'));
    await pendingCount;
    assert.equal(closing.dispatches(), 1);
    membership.close();
    stop();
    assert.equal(events.listenerCount('group-info-updated'), 0);
    assert.equal(events.listenerCount('group-membership'), 0);
    assert.equal(events.listenerCount('group-admin'), 0);
    assert.equal(events.listenerCount('group-mute'), 0);
    assert.equal(events.listenerCount('friend-added'), 0);
    return {
      groupEventIngressInstalledContract: true,
      groupEventCapturedScalarsContract: true,
      groupEventIntrinsicMapContract: true,
      groupEventProjectionFailureContract: true,
      groupQueryCapturedDtoContract: true,
      groupMemberIntrinsicMapContract: true,
      groupFileCountControlledContract: true,
      nativeGroupFileCountAttempted: false,
      groupFolderDeleteControlledContract: true,
      groupFolderDeleteBinaryGateContract: true,
      groupFolderCreateControlledContract: true,
      groupFolderCreateBinaryGateContract: true,
      nativeGroupFolderCreateAttempted: false,
      nativeGroupFolderDeleteAttempted: false,
      groupEssenceControlledContract: true,
      groupEssencePageControlledContract: true,
      realGroupEssenceHttpAttempted: false,
      nativeGroupEssenceMutationAttempted: false,
      friendAddedEventContract: true,
      nativeFriendAddedObserved: false,
      friendCategoryCreationContract: true,
      friendCategoryCreationMethodCaptureContract: true,
      friendCategoryCreationAcquireCloseContract: true,
      nativeFriendCategoryCreationAttempted: false,
      ...(await verifyContactGroupWorkerRoutes({
        QQClient,
        workerPath: join(packageRoot, 'dist/worker.js'),
        kernelPath: join(packageRoot, 'dist/kernel.js'),
      })),
    };
  } finally {
    await facade.close();
  }
}
