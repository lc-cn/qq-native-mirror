import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Actual worker IPC with only the kernel and dlopen replaced by local fixtures. */
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
  worker.stdout.resume();
  worker.stderr.resume();
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
    const friendNotices = [];
    client.on('friend-added', (notice) => friendNotices.push(notice));
    await client.login({ method: 'restore', uin: '123' });
    assert.deepEqual(friendNotices, [{ uid: 'u_fixture_friend', messageId: '9' }]);
    assert.deepEqual(await client.addFriendCategory(' 新分组 '), {
      categoryId: 8,
      name: ' 新分组 ',
    });
    assert.equal(
      await client.deleteGroupFolder('18446744073709551615', ' opaque/文件夹 '),
      undefined,
    );
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

export async function verifyContactGroupConsumer(packageRoot) {
  const load = (file) => import(pathToFileURL(join(packageRoot, 'dist', file)).href);
  const { QQClient } = await load('index.js');
  const { prepareCommand, observeWatchEvents } = await load('cli.js');
  const { createGroupEvents } = await load('features/groups/group-events.js');
  const { EventEmitter } = await import('node:events');
  const calls = [];
  await (
    await prepareCommand('group-muted', { 'group-id': '123' })
  )({
    listGroupMutedMembers: async (id) => {
      calls.push(['muted', id]);
      return [];
    },
  });
  await (
    await prepareCommand('group-info', { 'group-id': '123' })
  )({
    getGroupInfo: async (id) => {
      calls.push(['info', id]);
      return {};
    },
  });
  await (
    await prepareCommand('friend-category-add', { name: ' 新分组 ' })
  )({
    addFriendCategory: async (name) => {
      calls.push(['add-category', name]);
      return { categoryId: 8, name };
    },
  });
  await assert.rejects(prepareCommand('friend-category-add', { name: ' ' }), /blank/);
  await (
    await prepareCommand('friend-categories', {})
  )({
    listFriendCategories: async () => {
      calls.push('categories');
      return [];
    },
  });
  await (
    await prepareCommand('group-remark', { 'group-id': '123', remark: '' })
  )({ setGroupRemark: async (...args) => calls.push(args) });
  await (
    await prepareCommand('group-essence', {
      'group-id': '123',
      'message-id': '9876543210123456789',
      enabled: 'false',
    })
  )({ setGroupEssenceMessage: async (...args) => calls.push(args) });
  assert.deepEqual(calls, [
    ['muted', '123'],
    ['info', '123'],
    ['add-category', ' 新分组 '],
    'categories',
    ['123', ''],
    ['123', '9876543210123456789', false],
  ]);
  const events = new EventEmitter(),
    lines = [];
  const stop = observeWatchEvents(events, 'normalized', (line) => lines.push(JSON.parse(line)));
  const listener = createGroupEvents((name, payload) => events.emit(name, payload));
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
  const { createGroupSystemEvents } = await load('features/groups/group-system-events.js');
  const membership = createGroupSystemEvents((name, payload) => events.emit(name, payload));
  membership.onRecvSysMsg([18, 2, 8, 34, 26, 7, 18, 5, 8, 123, 32, 130, 1]);
  // Valid envelope with an absent subject; no identity fields are invented.
  assert.equal(lines.at(-1).event, 'group-membership');
  assert.equal(lines.at(-1).payload.kind, 'leave');
  membership.onRecvSysMsg([18, 2, 8, 44, 26, 11, 18, 9, 8, 123, 34, 5, 18, 3, 10, 1, 117]);
  assert.equal(lines.at(-1).event, 'group-admin');
  assert.equal(lines.at(-1).payload.memberUid, 'u');
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
  assert.equal(lines.at(-1).event, 'group-mute');
  assert.equal(lines.at(-1).payload.scope, 'all');

  const folderCliCalls = [];
  await (
    await prepareCommand('group-folder-delete', {
      'group-id': '18446744073709551615',
      'folder-id': ' opaque/文件夹 ',
    })
  )({ deleteGroupFolder: async (...args) => folderCliCalls.push(args) });
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
  const { deleteGroupFolder } = await load('features/groups/group-file-operations.js');
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
      deleteGroupFolder(group, folder) {
        assert.equal(this, service);
        assert.equal(group, '18446744073709551615');
        assert.equal(folder, ' opaque/文件夹 ');
        calls++;
        return Promise.resolve(response);
      },
    };
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
  const { createNativeServices } = await load('native-services.js');
  let folderDispatches = 0;
  const folderServices = createNativeServices({
    version: 'fixture',
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

  let compiledMsg;
  const groupListeners = [];
  const essenceCalls = [];
  const compiledServices = createNativeServices({
    session: {
      getMsgService: () => ({
        addKernelMsgListener(value) {
          compiledMsg = value;
        },
        getMsgsByMsgId(peer, ids) {
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
        addKernelGroupListener(value) {
          groupListeners.push(value);
        },
        getGroupShutUpMemberList(id) {
          for (const listener of groupListeners) listener.onShutUpMemberListChanged(id, []);
          return { result: 0 };
        },
        addGroupEssence(request) {
          essenceCalls.push(['add', request]);
          return { errCode: 0, result: { errorCode: 0 } };
        },
        removeGroupEssence(request) {
          essenceCalls.push(['remove', request]);
          return { errCode: 0, result: { errorCode: 8, wording: 'must not be serialized' } };
        },
      }),
    },
    version: '7.0.2-53644',
    events: { emit: (name, value) => events.emit(name, value) },
  });
  try {
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
    await compiledServices.invokeOperation('setGroupEssenceMessage', { ...intent, enabled: true });
    await assert.rejects(
      compiledServices.invokeOperation('setGroupEssenceMessage', { ...intent, enabled: false }),
      (error) => error.code === 8 && !error.message.includes('must not'),
    );
    assert.deepEqual(essenceCalls, [
      ['add', { groupCode: '123', msgSeq: 9, msgRandom: 4294967295 }],
      ['remove', { groupCode: '123', msgSeq: 9, msgRandom: 4294967295 }],
    ]);
  } finally {
    compiledServices.close();
  }
  const { getGroupEssencePage } = await load('features/groups/group-essence-list.js');
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
        pageRequests.push(new URL(url));
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
  const listCalls = [];
  await (
    await prepareCommand('group-essence-list', {
      'group-id': '123',
      'page-start': '17',
      'page-limit': '2',
    })
  )({ getGroupEssencePage: async (...args) => listCalls.push(args) });
  assert.deepEqual(listCalls, [['123', { pageStart: 17, pageLimit: 2 }]]);
  const categoryProfile = {
    platform: 'darwin',
    arch: 'arm64',
    clientVersion: '7.0.2-53644',
    wrapperSha256: 'fbc8ad9b328d05e16784d76b0181dda894c17001179dbf8c0d5dd00dc6271358',
  };
  const categoryCalls = [];
  const categoryServices = createNativeServices({
    session: {
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({
        addKernelBuddyListener() {},
        addCategoryV2(...args) {
          categoryCalls.push(args);
          return { result: 0, groupId: 8, name: 'native' };
        },
      }),
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
  } finally {
    categoryServices.close();
  }
  const countCalls = [];
  const countPlan = await prepareCommand('group-file-count', { 'group-id': '000123' });
  assert.equal(
    await countPlan({
      getGroupFileCount: async (group) => {
        countCalls.push(group);
        return 0;
      },
    }),
    0,
  );
  assert.deepEqual(countCalls, ['000123']);
  await assert.rejects(
    prepareCommand('group-file-count', { 'group-id': '18446744073709551616' }),
    /uint64/,
  );
  await assert.rejects(prepareCommand('group-file-count', { 'group-id': '0' }));
  const countFixture = (response, profile = categoryProfile) => {
    let acquisitions = 0,
      dispatches = 0;
    const native = {
      batchGetGroupFileCount(groups) {
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
        await assert.rejects(
          pending,
          (error) => error.code === expectedCode && !error.message.includes('PRIVATE'),
        );
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
  let rejectLate;
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
    groupFileCountControlledContract: true,
    nativeGroupFileCountAttempted: false,
    groupFolderDeleteControlledContract: true,
    nativeGroupFolderDeleteAttempted: false,
    groupEssenceControlledContract: true,
    groupEssencePageControlledContract: true,
    realGroupEssenceHttpAttempted: false,
    nativeGroupEssenceMutationAttempted: false,
    friendAddedEventContract: true,
    nativeFriendAddedObserved: false,
    friendCategoryCreationContract: true,
    nativeFriendCategoryCreationAttempted: false,
    ...(await verifyContactGroupWorkerRoutes({
      QQClient,
      workerPath: join(packageRoot, 'dist/worker.js'),
      kernelPath: join(packageRoot, 'dist/kernel.js'),
    })),
  };
}
