import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

/** An isolated Node process makes GC counts independent of the other package
 * checks. Bound growth, not an absolute VM-specific baseline. */
function verifyRequestWaitRetention(installedRoot) {
  const probe = `
import {queryObjects} from 'node:v8';
import {pathToFileURL} from 'node:url';
const {createFriendRequests}=await import(pathToFileURL(process.argv[1]).href);
let listener;
const service={
 addKernelBuddyListener(value){listener=value;return 7;},removeKernelBuddyListener(){},
 getBuddyReq(){listener.onBuddyReqChange({buddyReqs:[]});return {result:0};}
};
const module=createFriendRequests({getBuddyService:()=>service,signal:new AbortController().signal,emit(){},awaitAlive:async value=>value});
await new Promise(resolve=>setImmediate(resolve));
const baseline=queryObjects(Promise,{format:'count'});
for(let i=0;i<300;i++)await module.invokeOperation('listFriendRequests');
await new Promise(resolve=>setImmediate(resolve));
const active=queryObjects(Promise,{format:'count'});
module.close();await new Promise(resolve=>setImmediate(resolve));
const closed=queryObjects(Promise,{format:'count'});
console.log(JSON.stringify({baseline,active,closed}));
`;
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        probe,
        join(installedRoot, 'dist/features/contacts/friend-requests.js'),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
    ),
  );
  for (const count of Object.values(result)) assert.ok(Number.isSafeInteger(count) && count >= 0);
  assert.ok(
    result.active <= result.baseline + 20,
    'completed request waits must not accumulate per query',
  );
  assert.ok(result.closed <= result.baseline + 20);
}

/** Exercise installed composition and callbacks using controlled Profile/Buddy
 * services. Success here establishes SDK behavior, not remote account changes. */
export async function verifyProfileRequestConsumer(installedRoot) {
  const load = (path) => import(pathToFileURL(join(installedRoot, 'dist', path)).href);
  const [{ createNativeServices }, { prepareCommand }, { QQClient }] = await Promise.all([
    load('native-services.js'),
    load('cli.js'),
    load('index.js'),
  ]);
  for (const text of ['', '  spaced signature  ']) {
    let actual;
    await (
      await prepareCommand('signature', { text })
    )({
      setSignature: async (value) => {
        actual = value;
      },
    });
    assert.equal(actual, text);
  }
  assert.equal(typeof QQClient.prototype.setSignature, 'function');
  const profileFixture = (nickname = 'original nickname', missing = false) => {
    let listener;
    const writes = [];
    const removed = [];
    const profile = {
      addKernelProfileListener(value) {
        listener = value;
        return 1;
      },
      removeKernelProfileListener(id) {
        removed.push(id);
      },
      fetchUserDetailInfo(trace, uids, source, biz) {
        assert.deepEqual([trace, uids, source, biz], ['BuddyProfileStore', ['self'], 1, [0]]);
        listener.onUserDetailInfoChanged({
          uid: 'self',
          simpleInfo: {
            coreInfo: missing ? {} : { nick: nickname },
            baseInfo: {
              longNick: 'original signature',
              sex: 255,
              birthday_year: 2000,
              birthday_month: 1,
              birthday_day: 2,
            },
          },
        });
        return { result: 0 };
      },
      modifyDesktopMiniProfile(payload) {
        writes.push(payload);
        return { result: 0 };
      },
    };
    const services = createNativeServices({
      session: {
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getProfileService: () => profile,
      },
      identity: { userId: '789', uid: 'self' },
      version: '7.0.2-53644',
      events: { emit() {} },
    });
    return { services, profile, writes, removed };
  };
  const birthday = { birthday_year: '2000', birthday_month: '1', birthday_day: '2' };
  const nickname = profileFixture();
  try {
    await nickname.services.invokeOperation('setNickname', { name: 'new nickname' });
    assert.deepEqual(nickname.writes, [
      {
        nick: 'new nickname',
        longNick: 'original signature',
        sex: 255,
        birthday,
        location: undefined,
      },
    ]);
    assert.deepEqual(nickname.removed, [1]);
  } finally {
    nickname.services.close();
  }
  for (const text of ['new signature', '']) {
    const f = profileFixture();
    try {
      await f.services.invokeOperation('setSignature', { text });
      assert.deepEqual(f.writes, [
        { nick: 'original nickname', longNick: text, sex: 255, birthday, location: undefined },
      ]);
    } finally {
      f.services.close();
    }
  }
  const missing = profileFixture('unused', true);
  try {
    await assert.rejects(
      missing.services.invokeOperation('setSignature', { text: 'new' }),
      /nickname|preserv|profile/i,
    );
    assert.equal(missing.writes.length, 0);
  } finally {
    missing.services.close();
  }

  const frozen = profileFixture();
  let finish;
  const response = new Promise((resolve) => {
    finish = resolve;
  });
  const fetch = frozen.profile.fetchUserDetailInfo;
  frozen.profile.fetchUserDetailInfo = (...args) => {
    fetch(...args);
    return response;
  };
  const input = { text: 'captured signature' };
  try {
    const pending = frozen.services.invokeOperation('setSignature', input);
    await new Promise((resolve) => setImmediate(resolve));
    input.text = 'later caller mutation';
    finish({ result: 0 });
    await pending;
    assert.equal(frozen.writes[0].longNick, 'captured signature');
  } finally {
    frozen.services.close();
  }
  const retiredProfile = profileFixture();
  retiredProfile.profile.modifyDesktopMiniProfile = (payload) => {
    retiredProfile.writes.push(payload);
    return {
      get result() {
        retiredProfile.services.close();
        return 0;
      },
    };
  };
  try {
    await assert.rejects(
      retiredProfile.services.invokeOperation('setSignature', { text: '' }),
      /closed|abort/i,
    );
    assert.equal(
      retiredProfile.writes.length,
      1,
      'already dispatched modification is not replayed',
    );
  } finally {
    retiredProfile.services.close();
  }

  const incoming = {
    friendUid: 'u_request',
    reqTime: '123',
    friendNick: 'nick',
    extWords: 'hello',
    isDecide: false,
    isUnread: true,
  };
  const requestFixture = (result = { result: 0 }, approve = () => undefined) => {
    let listener;
    const events = [];
    const removed = [];
    let gets = 0;
    let approvals = 0;
    const services = createNativeServices({
      session: {
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getBuddyService: () => ({
          addKernelBuddyListener(value) {
            listener = value;
            return 7;
          },
          removeKernelBuddyListener(id) {
            removed.push(id);
          },
          getBuddyReq() {
            gets++;
            listener.onBuddyReqChange({ buddyReqs: [incoming] });
            return result;
          },
          approvalFriendRequest(payload) {
            approvals++;
            assert.deepEqual(payload, { friendUid: 'u_request', reqTime: '123', accept: false });
            return approve();
          },
        }),
      },
      version: '7.0.2-53644',
      events: { emit: (name, payload) => events.push([name, payload]) },
    });
    return { services, events, removed, gets: () => gets, approvals: () => approvals };
  };
  const requests = requestFixture();
  try {
    const listed = await requests.services.invokeOperation('listFriendRequests');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].uid, 'u_request');
    assert.equal(requests.events[0][0], 'friend-request');
    await requests.services.invokeOperation('handleFriendRequest', {
      request: { uid: 'u_request', time: '123' },
      accept: false,
    });
    assert.equal(requests.gets(), 1);
    assert.equal(requests.approvals(), 1);
  } finally {
    requests.services.close();
  }
  assert.deepEqual(requests.removed, [7]);
  const failed = requestFixture({ result: 73 });
  try {
    await assert.rejects(failed.services.invokeOperation('listFriendRequests'), { code: 73 });
    await assert.rejects(
      failed.services.invokeOperation('listFriendRequests'),
      /invalid.*recreate/i,
    );
    assert.equal(failed.gets(), 1, 'a failed uncorrelated query cannot be replayed');
  } finally {
    failed.services.close();
  }

  let rejectNative;
  let started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const native = new Promise((_resolve, reject) => {
    rejectNative = reject;
  });
  const closing = requestFixture({ result: 0 }, () => {
    started();
    return native;
  });
  const pending = closing.services.invokeOperation('handleFriendRequest', {
    request: { uid: 'u_request', time: '123' },
    accept: false,
  });
  await began;
  closing.services.close();
  let deadline;
  try {
    await assert.rejects(
      Promise.race([
        pending,
        new Promise((_resolve, reject) => {
          deadline = setTimeout(() => reject(Error('Request retirement did not settle')), 1500);
        }),
      ]),
      /closed|abort/i,
    );
  } finally {
    clearTimeout(deadline);
  }
  rejectNative(Error('Late controlled approval rejection'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closing.approvals(), 1);
  assert.deepEqual(closing.removed, [7]);
  const approvalResult = {
    get result() {
      retiredApproval.services.close();
      return 0;
    },
  };
  const retiredApproval = requestFixture({ result: 0 }, () => approvalResult);
  try {
    await assert.rejects(
      retiredApproval.services.invokeOperation('handleFriendRequest', {
        request: { uid: 'u_request', time: '123' },
        accept: false,
      }),
      /closed|abort/i,
    );
    assert.equal(retiredApproval.approvals(), 1);
    assert.deepEqual(retiredApproval.removed, [7]);
  } finally {
    retiredApproval.services.close();
  }
  verifyRequestWaitRetention(installedRoot);
  return {
    selfProfileContract: true,
    profileRequestInstalledComposition: true,
    profileInputSnapshotContract: true,
    friendRequestCompletionContract: true,
    friendRequestRetirementContract: true,
    profileRequestStatusRetirementContract: true,
    friendRequestWaitRetentionBounded: true,
    nativeExecuted: false,
    accountUsed: false,
  };
}
