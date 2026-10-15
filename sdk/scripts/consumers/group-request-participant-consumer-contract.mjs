import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClientWorkerFixture } from './client-worker-fixture.mjs';

/** @typedef {{
 * QQClient: typeof import('../../src/index.ts').QQClient,
 * createNativeServices: typeof import('../../src/native-services.ts').createNativeServices,
 * prepareCommand: typeof import('../../src/cli.ts').prepareCommand,
 * runClientCommand: typeof import('../../src/cli/client-command.ts').runClientCommand,
 * observeWatchEvents: typeof import('../../src/cli/client-command.ts').observeWatchEvents
 * }} ParticipantApi */

/** Keep both IPC directions observable while invoking the real feature owner. */
class CompositionWorker extends ClientWorkerFixture {
  /** @type {(command: Record<string, unknown>) => Promise<unknown>} */
  execute = async () => undefined;

  /** @param {import('node:child_process').Serializable} message
   * @param {unknown[]} args */
  send(message, ...args) {
    assert.ok(message && typeof message === 'object');
    const command = /** @type {Record<string, unknown>} */ (message);
    this.requests.push(command);
    const callback = args.find((value) => typeof value === 'function');
    if (typeof callback === 'function') Reflect.apply(callback, undefined, [null]);
    /** @param {object} reply */
    const complete = (reply) => {
      this.emit('message', { id: command.id, ...reply });
      if (command.method === 'close') this.exit();
    };
    this.execute(command).then(
      (result) => complete({ result }),
      (error) => complete({ error: { message: String(error) } }),
    );
    return true;
  }
}

const account = { uin: '123', uid: 'u_self' };

/** @param {string} sequence @param {number} type @param {number} [status] */
const notice = (sequence, type, status = 1) => ({
  seq: sequence,
  type,
  status,
  group: { groupCode: '000789' },
  postscript: 'request text',
  user1: { uid: 'u_applicant', nickName: 'Applicant' },
  user2: { uid: 'u_inviter', nickName: 'Inviter' },
});

/** @param {ParticipantApi} api @param {unknown[]} rows */
function fixture({ QQClient, createNativeServices }, rows) {
  const worker = new CompositionWorker();
  const client = new QQClient(worker, 5000);
  /** @type {import('../../src/features/groups/group-requests.ts').GroupRequestListener[]} */
  const listeners = [];
  /** @type {unknown[][]} */
  const calls = [];
  /** @type {{ name: string, payload: unknown }[]} */
  const emitted = [];
  const application = () => {
    const listener = listeners.find((value) => Object.hasOwn(value, 'onGroupSingleScreenNotifies'));
    assert.ok(listener, 'Native composition must register the request listener');
    return listener;
  };
  const services = createNativeServices({
    session: {
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getGroupService: () => ({
        /** @param {import('../../src/features/groups/group-requests.ts').GroupRequestListener} listener */
        addKernelGroupListener(listener) {
          listeners.push(listener);
          return listeners.length;
        },
        removeKernelGroupListener() {},
        /** @param {boolean} doubt @param {string} before @param {number} limit */
        getSingleScreenNotifies(doubt, before, limit) {
          calls.push(['get', doubt, before, limit]);
          application().onGroupSingleScreenNotifies(doubt, '99', rows);
          return { result: 0 };
        },
        /** @param {unknown[]} args */
        operateSysNotify(...args) {
          calls.push(['operate', ...args]);
          return { result: 0 };
        },
      }),
    },
    version: '7.0.2-53644',
    events: {
      emit(name, payload) {
        emitted.push({ name, payload });
        worker.emit('message', { event: name, payload });
      },
    },
  });
  worker.execute = async (command) => {
    if (command.method === 'close') {
      services.close();
      return;
    }
    if (command.method !== 'listGroupRequests' && command.method !== 'handleGroupRequest')
      assert.fail('Unexpected public group-request command');
    return services.invokeOperation(command.method, command);
  };
  worker.emit('message', { event: 'ready', payload: account });
  return {
    client,
    worker,
    calls,
    emitted,
    async close() {
      services.close();
      await client.close();
    },
  };
}

/** Run the same public composition against actual installed compiled modules.
 * @param {string} packageRoot */
export async function verifyGroupRequestParticipantConsumer(packageRoot) {
  const [api, native, cli, runtime] = await Promise.all([
    /** @type {Promise<typeof import('../../src/index.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/index.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/native-services.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/native-services.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/cli.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/cli.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/cli/client-command.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/cli/client-command.js')).href)
    ),
  ]);
  return verifyGroupRequestParticipantClient({ ...api, ...native, ...cli, ...runtime });
}

/** Actual Group callback → feature projection → controlled IPC → public client.
 * Authentication and native calls are controlled; no QQ addon/account is used.
 * @param {ParticipantApi} api */
export async function verifyGroupRequestParticipantClient(api) {
  const joinRequest = notice('0009007199254740993123', 7);
  joinRequest.user1 = { uid: '  u_exact  ', nickName: '  申请者 👋  ' };
  const approvalRequest = notice('12', 5);
  const invitation = notice('13', 1);
  const handled = notice('14', 7, 2);
  const rows = [joinRequest, approvalRequest, invitation, handled];
  const f = fixture(api, rows);
  /** @type {import('../../src/index.ts').GroupRequestEvent[]} */
  const events = [];
  /** @type {string[]} */
  const watch = [];
  f.client.on('request.group', (event) => events.push(event));
  const stopWatching = api.observeWatchEvents(f.client, 'normalized', (line) => watch.push(line));
  try {
    const page = await f.client.listGroupRequests({ doubt: true, before: '10', limit: 4 });
    assert.equal(page.next, '99');
    assert.equal(page.requests.length, 4);
    assert.deepEqual(f.calls, [['get', true, '10', 4]]);
    assert.equal(events.length, 3, 'Only pending requests produce approval events');
    const expected = [
      { applicant: { uid: '  u_exact  ', nickname: '  申请者 👋  ' } },
      { applicant: { uid: 'u_applicant', nickname: 'Applicant' } },
      { inviter: { uid: 'u_inviter', nickname: 'Inviter' } },
      {},
    ];
    for (let index = 0; index < page.requests.length; index++) {
      const request = page.requests[index];
      assert.ok(request);
      const participants = {
        ...(request.applicant ? { applicant: request.applicant } : {}),
        ...(request.inviter ? { inviter: request.inviter } : {}),
      };
      assert.deepEqual(participants, expected[index]);
      assert.equal(Object.hasOwn(request, 'approve'), false);
      for (const person of Object.values(participants)) {
        assert.equal(Object.hasOwn(person, 'userId'), false);
        assert.equal(Object.hasOwn(person, 'uin'), false);
      }
      const event = events[index];
      if (event) {
        assert.deepEqual(event.applicant, request.applicant);
        assert.deepEqual(event.inviter, request.inviter);
        const serialized = JSON.parse(watch[index]);
        assert.equal(serialized.event, 'request.group');
        assert.deepEqual(serialized.payload.applicant, request.applicant);
        assert.deepEqual(serialized.payload.inviter, request.inviter);
        assert.equal(Object.hasOwn(serialized.payload, 'approve'), false);
      }
    }
    assert.equal(watch.length, 3);
    stopWatching();
    for (const value of f.emitted.filter((event) => event.name === 'request.group')) {
      assert.ok(value.payload && typeof value.payload === 'object');
      assert.equal(Object.hasOwn(value.payload, 'approve'), false);
    }
    const first = events[0];
    assert.ok(first?.applicant);
    assert.notEqual(first.applicant, joinRequest.user1);
    joinRequest.user1.uid = 'u_raw_changed';
    joinRequest.user1.nickName = 'raw changed';
    assert.deepEqual(first.applicant, expected[0]?.applicant);
    // Display and raw are caller-observable data, never the approval identity.
    Reflect.set(first.applicant, 'uid', 'u_display_changed');
    first.applicant = { uid: 'u_replaced' };
    first.message = 'display changed';
    first.groupId = '999';
    first.sequence = '8';
    first.type = 1;
    first.doubt = false;
    joinRequest.group.groupCode = '888';
    joinRequest.seq = '9';
    joinRequest.type = 5;
    first.raw = { replaced: true };
    await first.approve(false, 'declined');
    await events[1]?.approve();
    await events[2]?.approve();
    assert.deepEqual(f.calls.slice(1), [
      [
        'operate',
        true,
        {
          operateType: 2,
          targetMsg: {
            seq: '0009007199254740993123',
            type: 7,
            groupCode: '000789',
            postscript: 'declined',
          },
        },
      ],
      [
        'operate',
        true,
        { operateType: 1, targetMsg: { seq: '12', type: 5, groupCode: '000789', postscript: ' ' } },
      ],
      [
        'operate',
        true,
        { operateType: 1, targetMsg: { seq: '13', type: 1, groupCode: '000789', postscript: ' ' } },
      ],
    ]);
    f.worker.emit('message', {
      event: 'disconnected',
      payload: { kind: 'transport', retryable: false },
    });
    f.worker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_other' } });
    const before = f.worker.requests.length;
    for (const event of events) await assert.rejects(event.approve(), /session|inactive/);
    assert.equal(f.worker.requests.length, before, 'Retired approvals must never reach IPC');
  } finally {
    stopWatching();
    await f.close();
  }
  await verifyOptionalParticipants(api);
  await verifyCliParticipants(api);
  return {
    groupRequestParticipantCompositionContract: true,
    groupRequestParticipantApprovalIdentityContract: true,
    groupRequestParticipantOptionalDataContract: true,
    groupRequestParticipantCliWatchContract: true,
    nativeGroupRequestAttempted: false,
    accountUsed: false,
  };
}

/** Representative incomplete native display carriers remain actionable.
 * @param {ParticipantApi} api */
async function verifyOptionalParticipants(api) {
  let reads = 0;
  const noCarrier = notice('21', 7);
  Object.defineProperty(noCarrier, 'user1', {
    get() {
      reads++;
      return { uid: 'u_getter' };
    },
  });
  const uidGetter = notice('22', 5);
  Object.defineProperty(uidGetter.user1, 'uid', {
    get() {
      reads++;
      return 'u_getter';
    },
  });
  const nicknameGetter = notice('23', 1);
  Object.defineProperty(nicknameGetter.user2, 'nickName', {
    get() {
      reads++;
      return 'getter';
    },
  });
  const wrongUid = notice('24', 7);
  Object.defineProperty(wrongUid.user1, 'uid', {
    value: {
      toString() {
        reads++;
        return 'u_coerced';
      },
    },
  });
  const blankNickname = notice('25', 5);
  blankNickname.user1.nickName = '   ';
  const nicknameTrap = notice('26', 1);
  nicknameTrap.user2 = new Proxy(nicknameTrap.user2, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'nickName') throw Error('controlled optional display descriptor failure');
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const f = fixture(api, [
    noCarrier,
    uidGetter,
    nicknameGetter,
    wrongUid,
    blankNickname,
    nicknameTrap,
  ]);
  const expected = [
    {},
    {},
    { inviter: { uid: 'u_inviter' } },
    {},
    { applicant: { uid: 'u_applicant' } },
    { inviter: { uid: 'u_inviter' } },
  ];
  /** @type {import('../../src/index.ts').GroupRequestEvent[]} */
  const events = [];
  f.client.on('request.group', (event) => events.push(event));
  try {
    const page = await f.client.listGroupRequests();
    assert.equal(page.requests.length, 6);
    assert.equal(events.length, 6);
    assert.equal(reads, 0);
    for (let index = 0; index < page.requests.length; index++) {
      const request = page.requests[index];
      const event = events[index];
      assert.ok(request && event);
      for (const key of /** @type {const} */ (['applicant', 'inviter'])) {
        assert.deepEqual(request[key], expected[index]?.[key]);
        assert.deepEqual(event[key], expected[index]?.[key]);
        assert.equal(Object.hasOwn(request, key), Object.hasOwn(expected[index], key));
        assert.equal(Object.hasOwn(event, key), Object.hasOwn(expected[index], key));
      }
    }
    await events[0]?.approve();
    assert.equal(f.calls.length, 2, 'Missing display data must not prevent approval');
    assert.equal(reads, 0);
  } finally {
    await f.close();
  }
}

/** @param {ParticipantApi} api */
async function verifyCliParticipants(api) {
  const f = fixture(api, [notice('31', 7), notice('32', 1)]);
  const signals = new EventEmitter();
  /** @type {string[]} */
  const output = [];
  try {
    f.client.login = async () => account;
    const action = await api.prepareCommand('group-requests', { limit: '2', doubt: 'false' });
    await api.runClientCommand({
      client: f.client,
      command: 'group-requests',
      action,
      login: { method: 'restore' },
      autoReconnect: false,
      qrPath: 'unused.png',
      writeQr: async () => assert.fail('No QR image is expected'),
      output: (line) => output.push(line),
      report: (line) => assert.fail(`Unexpected CLI report: ${line}`),
      signals,
      setExitCode: () => assert.fail('No signal is expected'),
    });
    assert.equal(output.length, 1);
    const page = JSON.parse(output[0]);
    assert.equal(page.requests.length, 2);
    assert.deepEqual(page.requests[0].applicant, { uid: 'u_applicant', nickname: 'Applicant' });
    assert.deepEqual(page.requests[1].inviter, { uid: 'u_inviter', nickname: 'Inviter' });
    assert.equal(
      page.requests.some(
        /** @param {object} request */ (request) => Object.hasOwn(request, 'approve'),
      ),
      false,
    );
    assert.equal(f.client.state, 'closed');
    assert.equal(f.worker.requests.filter((request) => request.method === 'close').length, 1);
    assert.deepEqual(signals.eventNames(), []);
  } finally {
    await f.close();
  }
}
