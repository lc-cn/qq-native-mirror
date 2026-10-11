import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Exercise the installed domain owners with controlled services, without QQ or an account.
 * @param {string} packageRoot
 */
export async function verifyContactGroupSnapshots(packageRoot) {
  /** @type {Promise<typeof import('../../src/features/contacts/contact-operations.ts')>} */
  const contacts = import(
    pathToFileURL(join(packageRoot, 'dist/features/contacts/contact-operations.js')).href
  );
  /** @type {Promise<typeof import('../../src/features/groups/group-operations.ts')>} */
  const groups = import(
    pathToFileURL(join(packageRoot, 'dist/features/groups/group-operations.js')).href
  );
  const [{ createContactOperations }, { createGroupOperations }] = await Promise.all([
    contacts,
    groups,
  ]);
  const account = new AbortController();
  const common = {
    signal: account.signal,
    resolveUid: async () => 'u_fixture',
    /** @template T @param {T | PromiseLike<T>} value */
    awaitAlive: async (value) => value,
  };

  let contactOptions = 0;
  let blockReads = 0;
  let bothReads = 0;
  let deletions = 0;
  const buddy = {
    /** @param {{friendUid: string, tempBlock: boolean, tempBothDel: boolean}} request */
    delBuddy(request) {
      assert.equal(this, buddy);
      assert.deepEqual(request, {
        friendUid: 'u_fixture',
        tempBlock: true,
        tempBothDel: false,
      });
      deletions++;
      return undefined;
    },
  };
  const contact = createContactOperations({
    ...common,
    getBuddyService: () => buddy,
    getProfileService: () => undefined,
  });
  await contact.invokeOperation('deleteFriend', {
    userId: '000123',
    get options() {
      contactOptions++;
      assert.equal(contactOptions, 1);
      return {
        get block() {
          return ++blockReads === 1 ? true : 'unvalidated';
        },
        get both() {
          return ++bothReads === 1 ? false : 'unvalidated';
        },
      };
    },
  });
  assert.deepEqual([contactOptions, blockReads, bothReads, deletions], [1, 1, 1, 1]);

  let groupOptions = 0;
  let rejectReads = 0;
  let reasonReads = 0;
  let kicks = 0;
  const group = {
    /** @param {string} id @param {string[]} uids @param {boolean} reject @param {string} reason */
    kickMember(id, uids, reject, reason) {
      assert.equal(this, group);
      assert.deepEqual([id, uids, reject, reason], ['000123', ['u_fixture'], false, ' exact ']);
      kicks++;
    },
  };
  const management = createGroupOperations({ ...common, getGroupService: () => group });
  await management.invokeOperation('kickGroupMember', {
    groupId: '000123',
    userId: '123',
    get options() {
      groupOptions++;
      assert.equal(groupOptions, 1);
      return {
        get rejectRejoin() {
          return ++rejectReads === 1 ? false : 'unvalidated';
        },
        get reason() {
          return ++reasonReads === 1 ? ' exact ' : 42;
        },
      };
    },
  });
  assert.deepEqual([groupOptions, rejectReads, reasonReads, kicks], [1, 1, 1, 1]);

  let coreReads = 0;
  const raw = {
    get coreInfo() {
      assert.equal(++coreReads, 1);
      return { uid: 'u_fixture', uin: '000123', nick: 'captured', remark: '' };
    },
  };
  const profile = createContactOperations({
    ...common,
    getBuddyService: () => undefined,
    getProfileService: () => ({ getCoreAndBaseInfo: () => new Map([['u_fixture', raw]]) }),
  });
  const projected = await profile.invokeOperation('getUserProfile', { userId: '000123' });
  assert.ok(projected);
  assert.equal(projected.raw, raw);
  assert.equal(projected.nickname, 'captured');
  assert.equal(coreReads, 1);

  // A receipt getter can synchronously retire the account. Neither a successful
  // status nor a projected nickname may escape after that retirement.
  for (const kind of ['contact', 'group']) {
    for (const abort of [false, true]) {
      const controller = new AbortController();
      const stopped = new Error('fixture account closed');
      let reads = 0;
      let dispatches = 0;
      const request = () => {
        dispatches++;
        return {
          get result() {
            reads++;
            if (abort) controller.abort(stopped);
            return abort ? 0 : reads === 1 ? 7 : 0;
          },
        };
      };
      const context = { ...common, signal: controller.signal };
      const pending =
        kind === 'contact'
          ? createContactOperations({
              ...context,
              getBuddyService: () => ({ delBuddy: request }),
              getProfileService: () => undefined,
            }).invokeOperation('deleteFriend', { userId: '123' })
          : createGroupOperations({
              ...context,
              getGroupService: () => ({ modifyGroupName: request }),
            }).invokeOperation('setGroupName', { groupId: '123', name: 'fixture' });
      await assert.rejects(pending, (error) => {
        if (abort) assert.equal(error, stopped);
        else {
          assert.ok(error instanceof Error);
          assert.equal(Reflect.get(error, 'code'), 7);
        }
        return true;
      });
      assert.deepEqual([reads, dispatches], [1, 1]);
    }
  }
  const closing = new AbortController();
  const stopped = new Error('fixture profile closed');
  const closingProfile = createContactOperations({
    ...common,
    signal: closing.signal,
    getBuddyService: () => undefined,
    getProfileService: () => ({
      getCoreAndBaseInfo: () =>
        new Map([
          [
            'u_fixture',
            {
              coreInfo: {
                uid: 'u_fixture',
                uin: '123',
                get nick() {
                  closing.abort(stopped);
                  return 'retired';
                },
              },
            },
          ],
        ]),
    }),
  });
  await assert.rejects(
    closingProfile.invokeOperation('getUserProfile', { userId: '123' }),
    (error) => error === stopped,
  );
  const lookupAccount = new AbortController();
  const lookupStopped = new Error('fixture lookup acquisition closed');
  let lookups = 0;
  const profiles = new Map([['u_fixture', raw]]);
  Object.defineProperty(profiles, 'get', {
    get() {
      lookupAccount.abort(lookupStopped);
      return () => {
        lookups++;
        return raw;
      };
    },
  });
  const lookupProfile = createContactOperations({
    ...common,
    signal: lookupAccount.signal,
    getBuddyService: () => undefined,
    getProfileService: () => ({ getCoreAndBaseInfo: () => profiles }),
  });
  await assert.rejects(
    lookupProfile.invokeOperation('getUserProfile', { userId: '000123' }),
    (error) => error === lookupStopped,
  );
  assert.equal(lookups, 0);
  assert.equal(account.signal.aborted, false);
  return {
    ...(await verifyPublicOperationInputs(packageRoot)),
    contactMutationSnapshotContract: true,
    groupMutationSnapshotContract: true,
    contactProfileSnapshotContract: true,
    contactGroupReceiptSnapshotContract: true,
    contactGroupProjectionRetirementContract: true,
    contactProfileLookupRetirementContract: true,
    nativeContactMutationAttempted: false,
    nativeGroupManagementAttempted: false,
    nativeContactProfileReadAttempted: false,
  };
}

/** Installed facade and CLI proof through a controlled IPC transport.
 * @param {string} packageRoot
 */
async function verifyPublicOperationInputs(packageRoot) {
  /** @type {Promise<typeof import('../../src/index.ts')>} */
  const entry = import(pathToFileURL(join(packageRoot, 'dist/index.js')).href);
  /** @type {Promise<typeof import('../../src/cli.ts')>} */
  const cli = import(pathToFileURL(join(packageRoot, 'dist/cli.js')).href);
  const [{ QQClient }, { prepareCommand }] = await Promise.all([entry, cli]);
  class ControlledWorker extends EventEmitter {
    connected = true;
    /** @type {number | null} */
    exitCode = null;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    /** @type {Record<string, unknown>[]} */
    requests = [];
    /** @param {Record<string, unknown>} value @param {(error: Error | null) => void} callback */
    send(value, callback) {
      this.requests.push(value);
      callback(null);
      queueMicrotask(() => {
        this.emit('message', { id: value.id, result: undefined });
        if (value.method === 'close') {
          this.connected = false;
          this.exitCode = 0;
          this.emit('exit', 0, null);
        }
      });
    }
    kill() {
      this.connected = false;
      this.exitCode = 0;
      queueMicrotask(() => this.emit('exit', 0, null));
      return true;
    }
  }
  const worker = new ControlledWorker();
  // Only this fixture transport is substituted; the facade and CLI are installed code.
  const client = new QQClient(
    /** @type {import('node:child_process').ChildProcess} */ (/** @type {unknown} */ (worker)),
    1000,
  );
  worker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_fixture' } });
  try {
    const invalid = [
      () => client.getUserProfile('invalid'),
      () => Reflect.apply(client.setFriendRemark, client, ['123', 42]),
      () => Reflect.apply(client.deleteFriend, client, ['123', { block: 'invalid' }]),
      () => client.setGroupName('123', ' '),
      () => client.setGroupRemark('0', ''),
      () => Reflect.apply(client.setGroupMute, client, ['123', 1]),
      () => client.setGroupMemberMute('123', '456', -1),
      () => client.setGroupMemberCard('123', 'invalid', ''),
      () => Reflect.apply(client.setGroupAdmin, client, ['123', '456', 'invalid']),
      () => Reflect.apply(client.kickGroupMember, client, ['123', '456', { reason: 42 }]),
      () => client.leaveGroup('invalid'),
      () => client.handleFriendRequest({ uid: 'u_fixture', time: 'invalid' }, true),
      () => client.listGroupRequests({ before: '' }),
      () =>
        Reflect.apply(client.handleGroupRequest, client, [
          { groupId: '123', sequence: '456', type: 8, doubt: false },
          true,
        ]),
    ];
    for (const attempt of invalid) await assert.rejects(async () => attempt());
    assert.equal(worker.requests.length, 0);
    let reads = 0;
    const options = {
      get block() {
        assert.equal(++reads, 1);
        return true;
      },
    };
    const deletion = client.deleteFriend('000123', options);
    Object.defineProperty(options, 'block', { value: false });
    await deletion;
    const sent = worker.requests.at(-1);
    assert.equal(sent?.method, 'deleteFriend');
    assert.equal(sent?.userId, '000123');
    assert.notEqual(sent?.options, options);
    assert.deepEqual(sent?.options, { block: true, both: false });
    assert.equal(reads, 1);
    const flags = {
      'group-id': '000123',
      'user-id': '000456',
      'reject-rejoin': 'true',
      reason: ' exact ',
    };
    const kick = await prepareCommand('group-kick', flags);
    flags['reject-rejoin'] = 'false';
    flags.reason = 'changed';
    await kick(client);
    const kicked = worker.requests.at(-1);
    assert.equal(kicked?.method, 'kickGroupMember');
    assert.equal(kicked?.groupId, '000123');
    assert.equal(kicked?.userId, '000456');
    assert.deepEqual(kicked?.options, { rejectRejoin: true, reason: ' exact ' });
    let requestReads = 0;
    const request = {
      get uid() {
        assert.equal(++requestReads, 1);
        return ' exact ';
      },
      time: '0000',
      get raw() {
        throw new Error('An approval must not read its event carrier');
      },
    };
    const handling = client.handleFriendRequest(request, false);
    request.time = 'changed';
    await handling;
    const handled = worker.requests.at(-1);
    assert.equal(handled?.method, 'handleFriendRequest');
    assert.notEqual(handled?.request, request);
    assert.deepEqual(handled?.request, { uid: ' exact ', time: '0000' });
    assert.equal(requestReads, 1);
    await client.listGroupRequests();
    assert.deepEqual(worker.requests.at(-1)?.options, { doubt: false, limit: 20 });
    const approvalFlags = {
      'group-id': '0000',
      sequence: '0001',
      type: '7',
      accept: 'false',
      reason: ' exact ',
    };
    const handlingPlan = await prepareCommand('group-request', approvalFlags);
    approvalFlags.reason = 'changed';
    await handlingPlan(client);
    const approval = worker.requests.at(-1);
    assert.equal(approval?.method, 'handleGroupRequest');
    assert.deepEqual(approval?.request, {
      groupId: '0000',
      sequence: '0001',
      type: 7,
      doubt: false,
    });
    assert.equal(approval?.accept, false);
    assert.equal(approval?.reason, ' exact ');
  } finally {
    await client.close();
  }
  assert.equal(worker.connected, false);
  assert.equal(worker.exitCode, 0);
  return {
    contactGroupFacadeInputContract: true,
    contactGroupFacadeDetachedOptionsContract: true,
    contactGroupCliCapturedPlanContract: true,
    contactGroupControlledIpcRetired: true,
    friendGroupRequestFacadePreflightContract: true,
    friendRequestDetachedIdentityContract: true,
    groupRequestDefaultCursorContract: true,
    groupRequestCliCapturedPlanContract: true,
  };
}
