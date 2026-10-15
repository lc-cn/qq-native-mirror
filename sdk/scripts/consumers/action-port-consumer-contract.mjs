import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Verify compiled action adapters from the installed archive, with controlled
 * services and the real Session lifetime. This never loads a QQ addon. */
/** @param {string} installedRoot */
export async function verifyActionPortConsumer(installedRoot) {
  const [contacts, groups, runtime, cli, client, composition, listeners] = await Promise.all([
    /** @type {Promise<typeof import('../../src/features/contacts/contact-operations.ts')>} */ (
      import(
        pathToFileURL(join(installedRoot, 'dist/features/contacts/contact-operations.js')).href
      )
    ),
    /** @type {Promise<typeof import('../../src/features/groups/group-operations.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/features/groups/group-operations.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/runtime/native-service-lifetime.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/runtime/native-service-lifetime.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/cli.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/cli.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/index.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/index.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/native-services.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/native-services.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/runtime/native-listener-owner.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/runtime/native-listener-owner.js')).href)
    ),
  ]);
  const { createContactOperations } = contacts;
  const { createGroupOperations } = groups;
  const { NativeServiceLifetime } = runtime;
  const { createNativeServices } = composition;
  const { NativeListenerOwner } = listeners;

  for (const known of [true, false]) {
    let reads = 0;
    let calls = 0;
    let closed = false;
    const payload = {};
    const overrides = {
      metadata: 1,
      get onValue() {
        reads++;
        if (reads !== 1) throw new Error('Installed callback getter reacquired');
        return known
          ? /** @this {object} @param {unknown} value */ function (value) {
              assert.equal(this, overrides);
              assert.equal(value, payload);
              calls++;
            }
          : undefined;
      },
    };
    const owner = new NativeListenerOwner({
      isClosed: () => closed,
      dispatch: (channel, args) => {
        assert.equal(known, false);
        assert.equal(channel, 'Msg/onValue');
        assert.deepEqual(args, [payload]);
        calls++;
      },
    });
    owner.register({
      family: 'Msg',
      overrides,
      add: (listener) => {
        const captured = listener.onValue;
        assert.equal(listener.onValue, captured);
        listener.onValue(payload);
        Object.defineProperty(overrides, 'onValue', { value: 7 });
        assert.equal(listener.onValue, captured);
        overrides.metadata = 2;
        assert.equal(listener.metadata, 2);
        closed = true;
        assert.equal(listener.onValue(payload), undefined);
        Object.defineProperty(overrides, 'onValue', {
          value: 7,
          configurable: false,
          writable: false,
        });
        assert.equal(listener.onValue, 7);
      },
    });
    assert.equal(reads, 1);
    assert.equal(calls, 1);
  }

  // Exercise the dispatch owner and actual composition from the archive. A
  // changing accessor exposes a check-then-read implementation without an addon.
  {
    const lifetime = new NativeServiceLifetime();
    const receipt = Promise.resolve({ opaque: true });
    let reads = 0;
    const service = {
      get nativeMethod() {
        reads++;
        return /** @this {object} @param {unknown[]} args */ function (...args) {
          assert.equal(this, service);
          assert.deepEqual(args, ['captured']);
          return receipt;
        };
      },
    };
    const { call } = lifetime;
    assert.equal(call(service, 'nativeMethod', 'captured'), receipt);
    assert.equal(reads, 1);
    await receipt;
    lifetime.close();
    assert.throws(() => call(service, 'nativeMethod'), /Native services are closed/);
    assert.equal(reads, 1);
  }
  for (const member of [undefined, () => assert.fail('Retired method dispatched')]) {
    const lifetime = new NativeServiceLifetime();
    let reads = 0;
    const service = {
      get nativeMethod() {
        reads++;
        lifetime.close();
        return member;
      },
    };
    assert.throws(() => lifetime.call(service, 'nativeMethod'), /Native services are closed/);
    assert.equal(reads, 1);
  }
  {
    let reads = 0;
    /** @type {number[]} */
    const capturedCalls = [];
    const msg = {
      get addKernelMsgListener() {
        const captured = ++reads;
        return /** @this {object} */ function () {
          assert.equal(this, msg);
          capturedCalls.push(captured);
        };
      },
    };
    const services = createNativeServices({
      session: {
        getMsgService: () => msg,
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
      },
      version: 'controlled',
      events: { emit() {} },
    });
    try {
      assert.equal(reads, 1);
      assert.deepEqual(capturedCalls, [1]);
    } finally {
      services.close();
    }
  }

  /** @param {typeof createContactOperations|typeof createGroupOperations} factory
   * @param {Partial<Pick<import('../../src/features/contacts/contact-operations.ts').ContactOperationsContext,'getBuddyService'|'getProfileService'>&Pick<import('../../src/features/groups/group-operations.ts').GroupOperationsContext,'getGroupService'>>} ports
   * @param {(id:string)=>Promise<string>} [resolveUid] */
  const fixture = (factory, ports, resolveUid = async () => 'u_fixture') => {
    const lifetime = new NativeServiceLifetime();
    const context = {
      getBuddyService: () => undefined,
      getProfileService: () => undefined,
      getGroupService: () => undefined,
      ...ports,
      resolveUid,
      signal: lifetime.signal,
      awaitAlive: lifetime.awaitAlive,
    };
    const contact =
      factory === createContactOperations ? createContactOperations(context) : undefined;
    const group = factory === createGroupOperations ? createGroupOperations(context) : undefined;
    /** @param {import('../../src/features/contacts/contact-operation-input.ts').ContactOperation|import('../../src/features/groups/group-operation-input.ts').GroupOperation} method
     * @param {Record<string,unknown>} payload */
    const invokeOperation = (method, payload) => {
      if (
        contact &&
        (method === 'setFriendRemark' ||
          method === 'deleteFriend' ||
          method === 'getUserProfile' ||
          method === 'getUserProfileByUid')
      )
        return contact.invokeOperation(method, payload);
      if (
        group &&
        method !== 'setFriendRemark' &&
        method !== 'deleteFriend' &&
        method !== 'getUserProfile' &&
        method !== 'getUserProfileByUid'
      )
        return group.invokeOperation(method, payload);
      throw Error('Fixture domain/operation mismatch');
    };
    return { operations: { invokeOperation }, lifetime };
  };
  const cases = /** @type {const} */ ([
    [
      createContactOperations,
      'setFriendRemark',
      { userId: '456', remark: '' },
      'getBuddyService',
      'setBuddyRemark',
    ],
    [createContactOperations, 'deleteFriend', { userId: '456' }, 'getBuddyService', 'delBuddy'],
    [
      createContactOperations,
      'getUserProfile',
      { userId: '456' },
      'getProfileService',
      'getCoreAndBaseInfo',
    ],
    [
      createGroupOperations,
      'setGroupName',
      { groupId: '123', name: 'name' },
      'getGroupService',
      'modifyGroupName',
    ],
    [
      createGroupOperations,
      'setGroupAdmin',
      { groupId: '123', userId: '456', enabled: true },
      'getGroupService',
      'modifyMemberRole',
    ],
  ]);
  // A service/method accessor may synchronously retire the Session. None of the
  // actions may call a function acquired from that retired generation.
  for (const [factory, operation, payload, getter, method] of cases) {
    for (const stage of ['service', 'method']) {
      let calls = 0;
      let reads = 0;
      const service = {};
      Object.defineProperty(service, method, {
        get() {
          reads++;
          if (stage === 'method') lifetime.close();
          return () => {
            calls++;
            return { result: 0 };
          };
        },
      });
      const f = fixture(factory, {
        [getter]() {
          if (stage === 'service') lifetime.close();
          return service;
        },
      });
      const lifetime = f.lifetime;
      await assert.rejects(f.operations.invokeOperation(operation, payload), /closed|abort/i);
      assert.equal(calls, 0);
      assert.equal(reads, stage === 'method' ? 1 : 0);
    }
  }

  for (const [factory, operation, payload, getter, method] of cases.filter(
    (c) => c[1] !== 'getUserProfile',
  )) {
    /** @type {()=>void} */
    let started = () => assert.fail('Begin resolver missing');
    /** @type {(reason:unknown)=>void} */
    let rejectNative = () => assert.fail('Late rejecter missing');
    let calls = 0;
    /** @type {Promise<void>} */
    const began = new Promise((resolve) => {
      started = resolve;
    });
    const native = new Promise((_resolve, reject) => {
      rejectNative = reject;
    });
    const f = fixture(factory, {
      [getter]: () => ({
        [method]() {
          calls++;
          started();
          return native;
        },
      }),
    });
    const pending = f.operations.invokeOperation(operation, payload);
    await began;
    f.lifetime.close();
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let deadline;
    try {
      await assert.rejects(
        Promise.race([
          pending,
          new Promise((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error('Action close did not settle')), 1500);
          }),
        ]),
        /closed|abort/i,
      );
    } finally {
      clearTimeout(deadline);
    }
    rejectNative(new Error('Late synthetic native rejection'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'a retired mutation is observed without replay');
  }

  /** @type {unknown[][]} */
  const calls = [];
  /** @type {import('../../src/features/groups/group-operations.ts').GroupMutationPort} */
  const service = {
    modifyMemberRole: (...args) => {
      calls.push(['role', args]);
    },
    modifyMemberCardName: (...args) => {
      calls.push(['card', args]);
    },
    kickMember: async (...args) => {
      calls.push(['kick', args]);
    },
    quitGroup: (...args) => {
      calls.push(['quit', args]);
    },
  };
  const f = fixture(createGroupOperations, { getGroupService: () => service });
  const facadeWorker = new ChildProcess();
  Object.defineProperty(facadeWorker, 'exitCode', { value: 0, configurable: true });
  const publicClient = new client.QQClient(facadeWorker, 5000);
  facadeWorker.emit('exit', 0, null);
  try {
    publicClient.setGroupAdmin = (groupId, userId, enabled) =>
      f.operations.invokeOperation('setGroupAdmin', { groupId, userId, enabled }).then(() => {});
    publicClient.setGroupMemberCard = (groupId, userId, card) =>
      f.operations.invokeOperation('setGroupMemberCard', { groupId, userId, card }).then(() => {});
    publicClient.kickGroupMember = (groupId, userId, options) =>
      f.operations.invokeOperation('kickGroupMember', { groupId, userId, options }).then(() => {});
    publicClient.leaveGroup = (groupId) =>
      f.operations.invokeOperation('leaveGroup', { groupId }).then(() => {});
    try {
      for (const method of /** @type {const} */ ([
        'setGroupAdmin',
        'setGroupMemberCard',
        'kickGroupMember',
        'leaveGroup',
      ]))
        assert.equal(typeof client.QQClient.prototype[method], 'function');
      for (const [command, flags] of /** @type {const} */ ([
        ['member-admin', { 'user-id': '456', enabled: 'true' }],
        ['member-card', { 'user-id': '456', card: '' }],
        ['group-kick', { 'user-id': '456' }],
        ['group-leave', {}],
      ]))
        await (
          await cli.prepareCommand(command, { 'group-id': '123', ...flags })
        )(publicClient);
      assert.deepEqual(calls, [
        ['role', ['123', 'u_fixture', 3]],
        ['card', ['123', 'u_fixture', '']],
        ['kick', ['123', ['u_fixture'], false, '']],
        ['quit', ['123']],
      ]);
    } finally {
      f.lifetime.close();
    }
  } finally {
    await publicClient.close();
  }
  const strict = fixture(createGroupOperations, {
    getGroupService: () => ({ modifyGroupName() {}, setGroupShutUp() {}, setMemberShutUp() {} }),
  });
  try {
    for (const [method, payload] of /** @type {const} */ ([
      ['setGroupName', { name: 'name' }],
      ['setGroupMute', { enabled: true }],
      ['setGroupMemberMute', { userId: '456', seconds: 0 }],
    ]))
      await assert.rejects(
        strict.operations.invokeOperation(method, { groupId: '123', ...payload }),
        { code: 'invalid-result' },
      );
  } finally {
    strict.lifetime.close();
  }
  // Keep the full multi-platform void-acknowledgement matrix in the same owner
  // used by local and CI installed consumers; neither caller duplicates ports.
  for (const [method, native, payload, expected] of /** @type {const} */ ([
    [
      'setGroupMemberCard',
      'modifyMemberCardName',
      { groupId: '123', userId: '456', card: '' },
      ['123', 'u_fixture', ''],
    ],
    [
      'setGroupAdmin',
      'modifyMemberRole',
      { groupId: '123', userId: '456', enabled: true },
      ['123', 'u_fixture', 3],
    ],
    [
      'kickGroupMember',
      'kickMember',
      { groupId: '123', userId: '456', options: { rejectRejoin: true, reason: 'fixture' } },
      ['123', ['u_fixture'], true, 'fixture'],
    ],
    ['leaveGroup', 'quitGroup', { groupId: '123' }, ['123']],
  ])) {
    for (const [result, code] of [
      [undefined, undefined],
      ['0', 'invalid-result'],
      [0, 'invalid-result'],
      [{ result: 23 }, 23],
      [{ result: '23' }, '23'],
      [{ result: 'denied' }, 'denied'],
      [{ result: 73 }, 73],
      [{ result: NaN }, 'invalid-result'],
      [{ result: Infinity }, 'invalid-result'],
      [{}, 'invalid-result'],
    ]) {
      let attempts = 0;
      const f = fixture(createGroupOperations, {
        getGroupService: () => ({
          [native](/** @type {unknown[]} */ ...args) {
            attempts++;
            assert.deepEqual(args, expected);
            return native === 'kickMember' ? Promise.resolve(result) : result;
          },
        }),
      });
      try {
        const pending = f.operations.invokeOperation(method, payload);
        if (code === undefined) await pending;
        else await assert.rejects(pending, { code });
        assert.equal(attempts, 1);
      } finally {
        f.lifetime.close();
      }
    }
  }
  return {
    groupOperationContract: true,
    nativeInvocationCaptureContract: true,
    nativeListenerCaptureContract: true,
    actionPortRetirementContract: true,
    actionPortPendingCloseContract: true,
    actionPortLateFailureObserved: true,
    nativeExecuted: false,
    accountUsed: false,
  };
}
