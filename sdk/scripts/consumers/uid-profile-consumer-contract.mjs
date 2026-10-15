import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClientWorkerFixture } from './client-worker-fixture.mjs';

/** @typedef {{
 * QQClient: typeof import('../../src/index.ts').QQClient,
 * createNativeServices: typeof import('../../src/native-services.ts').createNativeServices,
 * prepareCommand: typeof import('../../src/cli/command-plan.ts').prepareCommand,
 * runClientCommand: typeof import('../../src/cli/client-command.ts').runClientCommand
 * }} UidProfileApi */

class CompositionWorker extends ClientWorkerFixture {
  /** @type {(command: Record<string, unknown>) => Promise<unknown>} */
  execute = async () => undefined;
  /** @type {((command: Record<string, unknown>) => void) | undefined} */
  afterReply;

  /** @param {import('node:child_process').Serializable} value @param {unknown[]} args */
  send(value, ...args) {
    assert.ok(value && typeof value === 'object');
    const command = /** @type {Record<string, unknown>} */ (value);
    this.requests.push(command);
    const callback = args.find((arg) => typeof arg === 'function');
    if (typeof callback === 'function') Reflect.apply(callback, undefined, [null]);
    /** @param {object} reply */
    const complete = (reply) => {
      this.emit('message', { id: command.id, ...reply });
      this.afterReply?.(command);
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
const uid = 'opaque-applicant';
const userId = '0009007199254740993123';
/** @param {unknown} [uin] @param {unknown} [identity] */
const profileRow = (uin = userId, identity = uid) => ({
  coreInfo: { uid: identity, uin, nick: 'Profile nickname', remark: 'Profile remark' },
});

/** @param {UidProfileApi} api */
function fixture({ QQClient, createNativeServices }) {
  const worker = new CompositionWorker();
  const client = new QQClient(worker, 5000);
  /** @type {import('../../src/features/groups/group-requests.ts').GroupRequestListener[]} */
  const listeners = [];
  /** @type {{method:string,args:unknown[]}[]} */
  const calls = [];
  const acquisitions = { profile: 0, buddy: 0, conversion: 0 };
  /** @type {unknown} */
  let response = new Map([[uid, profileRow()]]);
  const profile = {
    /** @this {unknown} @param {string} store @param {string[]} uids */
    getCoreAndBaseInfo(store, uids) {
      assert.equal(this, profile);
      calls.push({ method: 'profile', args: [store, [...uids]] });
      return response;
    },
  };
  const services = createNativeServices({
    session: {
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getBuddyService: () => {
        acquisitions.buddy++;
        return { addKernelBuddyListener() {} };
      },
      getUixConvertService: () => {
        acquisitions.conversion++;
        assert.fail('Explicit UID profile reads cannot resolve another identity');
      },
      getProfileService: () => {
        acquisitions.profile++;
        return profile;
      },
      getGroupService: () => ({
        /** @param {import('../../src/features/groups/group-requests.ts').GroupRequestListener} listener */
        addKernelGroupListener(listener) {
          listeners.push(listener);
          return listeners.length;
        },
        removeKernelGroupListener() {},
        /** @param {boolean} doubt @param {string} before @param {number} limit */
        getSingleScreenNotifies(doubt, before, limit) {
          calls.push({ method: 'requests', args: [doubt, before, limit] });
          const listener = listeners.find((value) =>
            Object.hasOwn(value, 'onGroupSingleScreenNotifies'),
          );
          assert.ok(listener);
          listener.onGroupSingleScreenNotifies(doubt, '99', [
            {
              seq: '00031',
              type: 7,
              status: 1,
              group: { groupCode: '000789' },
              postscript: 'controlled request',
              user1: { uid, nickName: 'Request nickname' },
            },
          ]);
          return { result: 0 };
        },
        /** @param {unknown[]} args */
        operateSysNotify(...args) {
          calls.push({ method: 'approve', args });
          return { result: 0 };
        },
      }),
    },
    version: '7.0.2-53644',
    events: { emit: (event, payload) => worker.emit('message', { event, payload }) },
  });
  worker.execute = async (command) => {
    if (command.method === 'close') {
      services.close();
      return;
    }
    if (
      !['getUserProfileByUid', 'listGroupRequests', 'handleGroupRequest'].includes(
        String(command.method),
      )
    )
      assert.fail('Unexpected UID profile consumer operation');
    return services.invokeOperation(
      /** @type {'getUserProfileByUid'|'listGroupRequests'|'handleGroupRequest'} */ (
        command.method
      ),
      command,
    );
  };
  acquisitions.profile = acquisitions.buddy = acquisitions.conversion = 0;
  worker.emit('message', { event: 'ready', payload: account });
  return {
    client,
    worker,
    calls,
    acquisitions,
    /** @param {unknown} value */
    respond(value) {
      response = value;
    },
    async close() {
      services.close();
      await client.close();
    },
  };
}

/** Load only literal installed paths; source tests inject the corresponding APIs.
 * @param {string} installedRoot */
export async function verifyUidProfileConsumer(installedRoot) {
  const [publicApi, native, cli, runtime] = await Promise.all([
    /** @type {Promise<typeof import('../../src/index.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/index.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/native-services.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/native-services.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/cli/command-plan.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/cli/command-plan.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/cli/client-command.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/cli/client-command.js')).href)
    ),
  ]);
  return verifyUidProfileClient({ ...publicApi, ...native, ...cli, ...runtime });
}

/** Controlled request callback → public UID query → Profile → explicit approval.
 * No account, QQ process, addon, HTTP service or native account operation is used.
 * @param {UidProfileApi} api */
export async function verifyUidProfileClient(api) {
  const f = fixture(api);
  /** @type {import('../../src/index.ts').GroupRequestEvent | undefined} */
  let event;
  f.client.on('request.group', (value) => {
    event = value;
  });
  try {
    const page = await f.client.listGroupRequests();
    assert.ok(event?.applicant);
    assert.deepEqual(page.requests[0]?.applicant, { uid, nickname: 'Request nickname' });
    assert.deepEqual(f.acquisitions, { profile: 0, buddy: 0, conversion: 0 });
    assert.equal(f.calls.length, 1, 'Request delivery must not automatically query Profile');
    const result = await f.client.getUserProfileByUid(event.applicant.uid);
    assert.deepEqual(result, {
      userId,
      uid,
      nickname: 'Profile nickname',
      remark: 'Profile remark',
      raw: profileRow(),
    });
    assert.deepEqual(f.calls[1], { method: 'profile', args: ['nodeStore', [uid]] });
    assert.deepEqual(f.acquisitions, { profile: 1, buddy: 0, conversion: 0 });
    await event.approve(false, 'controlled decline');
    assert.deepEqual(f.calls[2], {
      method: 'approve',
      args: [
        false,
        {
          operateType: 2,
          targetMsg: {
            seq: '00031',
            type: 7,
            groupCode: '000789',
            postscript: 'controlled decline',
          },
        },
      ],
    });
    assert.equal(f.calls.filter((call) => call.method === 'profile').length, 1);
    // A previous success must never substitute for a missing fresh profile.
    f.respond(new Map());
    await assert.rejects(f.client.getUserProfileByUid(uid), /profile|requested/i);
    assert.equal(f.acquisitions.profile, 2);
    assert.equal(f.acquisitions.buddy, 0);
    assert.equal(f.acquisitions.conversion, 0);
  } finally {
    await f.close();
  }
  await verifyUidValidation(api);
  await verifyProfileResults(api);
  await verifyRetirement(api);
  await verifyCli(api);
  return {
    explicitUidProfileCompositionContract: true,
    uidProfileNoAutomaticLookupOrFallback: true,
    uidProfileExactIdentityContract: true,
    uidProfileOriginalSessionContract: true,
    uidProfileCliLifecycleContract: true,
    nativeProfileQueryAttempted: false,
    accountUsed: false,
  };
}

/** @param {UidProfileApi} api */
async function verifyUidValidation(api) {
  const f = fixture(api);
  try {
    for (const value of [
      undefined,
      null,
      123,
      '',
      ' ',
      ' padded',
      'padded ',
      'masked*uid',
      { toString: () => assert.fail('UID inputs cannot be coerced') },
    ]) {
      await assert.rejects(Reflect.apply(f.client.getUserProfileByUid, f.client, [value]));
    }
    assert.deepEqual(f.worker.requests, []);
    assert.deepEqual(f.acquisitions, { profile: 0, buddy: 0, conversion: 0 });
    for (const identity of ['opaque-without-prefix', '123']) {
      f.respond(new Map([[identity, profileRow(userId, identity)]]));
      assert.equal((await f.client.getUserProfileByUid(identity)).uid, identity);
      assert.deepEqual(f.calls.at(-1), { method: 'profile', args: ['nodeStore', [identity]] });
    }
    assert.equal(f.acquisitions.profile, 2);
    assert.equal(f.acquisitions.conversion, 0);
  } finally {
    await f.close();
  }
}

/** @param {UidProfileApi} api */
async function verifyProfileResults(api) {
  const f = fixture(api);
  const forged = new Map([['other', profileRow()]]);
  Object.defineProperty(forged, 'get', { value: () => profileRow() });
  const invalid = [
    undefined,
    null,
    {},
    [],
    new Map(),
    new Map([['other', profileRow()]]),
    forged,
    new Map([[uid, profileRow(userId, 'other')]]),
    new Map([[uid, {}]]),
    new Map([[uid, { coreInfo: { uin: userId } }]]),
    new Map([[uid, { coreInfo: { uid } }]]),
  ];
  for (const uin of ['', '0', '000', '-1', '+1', '1.2', '1e3', '123 ', 123, null])
    invalid.push(new Map([[uid, profileRow(uin)]]));
  try {
    for (const response of invalid) {
      f.respond(response);
      const before = f.calls.length;
      await assert.rejects(f.client.getUserProfileByUid(uid), /profile|identity|Map|requested/i);
      assert.equal(f.calls.length, before + 1, 'Invalid results neither retry nor fall back');
    }
    const stored = new Map([[uid, profileRow()]]);
    Object.defineProperty(stored, 'get', {
      get: () => assert.fail('UID queries read actual Map storage'),
    });
    f.respond(stored);
    assert.equal((await f.client.getUserProfileByUid(uid)).userId, userId);
    assert.deepEqual(f.acquisitions, { profile: invalid.length + 1, buddy: 0, conversion: 0 });
  } finally {
    await f.close();
  }
}

/** @param {UidProfileApi} api */
async function verifyRetirement(api) {
  const f = fixture(api);
  f.worker.afterReply = (command) => {
    if (command.method !== 'getUserProfileByUid') return;
    f.worker.emit('message', {
      event: 'disconnected',
      payload: { source: 'login', kind: 'transport', retryable: false, args: [] },
    });
    f.worker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_next' } });
  };
  try {
    await assert.rejects(f.client.getUserProfileByUid(uid), /inactive|session|replaced/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.acquisitions.profile, 1);
  } finally {
    await f.close();
  }
  const pendingFixture = fixture(api);
  /** @type {(reason: Error) => void} */
  let rejectNative = () => assert.fail('Native response not installed');
  pendingFixture.respond(
    new Promise((_, reject) => {
      rejectNative = reject;
    }),
  );
  const rejected = assert.rejects(
    pendingFixture.client.getUserProfileByUid(uid),
    /clos|abort|retir|exited/i,
  );
  await pendingFixture.close();
  await rejected;
  rejectNative(new Error('late controlled profile rejection'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingFixture.calls.length, 1);
}

/** @param {UidProfileApi} api */
async function verifyCli(api) {
  for (const missing of [false, true]) {
    const f = fixture(api);
    const signals = new EventEmitter();
    /** @type {string[]} */
    const output = [];
    let logins = 0;
    try {
      f.client.login = async () => {
        logins++;
        return account;
      };
      if (missing) f.respond(new Map());
      const flags = { uid, config: 'controlled-unused-config.json', uin: account.uin };
      const action = await api.prepareCommand('profile-uid', flags);
      flags.uid = 'later-change';
      const pending = api.runClientCommand({
        client: f.client,
        command: 'profile-uid',
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
      if (missing) {
        await assert.rejects(pending, /profile|requested/i);
        assert.deepEqual(output, []);
      } else {
        await pending;
        assert.equal(output.length, 1);
        assert.equal(JSON.parse(output[0]).userId, userId);
      }
      assert.equal(logins, 1);
      assert.equal(f.client.state, 'closed');
      assert.deepEqual(signals.eventNames(), []);
      assert.deepEqual(f.calls, [{ method: 'profile', args: ['nodeStore', [uid]] }]);
      assert.equal(f.worker.requests.filter((command) => command.method === 'close').length, 1);
    } finally {
      await f.close();
    }
  }
  for (const value of ['', ' padded', 'masked*uid'])
    await assert.rejects(api.prepareCommand('profile-uid', { uid: value }));
}
