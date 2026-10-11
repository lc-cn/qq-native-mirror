import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Exercise installed compiled composition with fake ticket/notice services.
 * This verifies adapter acknowledgement semantics, never remote publication. */
export async function verifyGroupNoticeConsumer(installedRoot) {
  const load = (path) => import(pathToFileURL(join(installedRoot, 'dist', path)).href);
  const [{ createNativeServices }, { prepareCommand }, { QQClient }] = await Promise.all([
    load('native-services.js'),
    load('cli.js'),
    load('index.js'),
  ]);
  for (const name of ['publishGroupNotice', 'deleteGroupNotice'])
    assert.equal(typeof QQClient.prototype[name], 'function');
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  };
  const settleWithin = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Notice settlement deadline exceeded')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const ticket = () => ({ result: 0, domainPskeyMap: new Map([['qun.qq.com', 'synthetic-key']]) });
  const fixture = () => {
    const calls = [];
    const tip = {
      getPskey(...args) {
        assert.equal(this, tip);
        calls.push(['ticket', ...args]);
        return ticket();
      },
    };
    const group = {
      addKernelGroupListener() {},
      uploadGroupBulletinPic(...args) {
        assert.equal(this, group);
        calls.push(['upload', ...args]);
        return { result: 0, errCode: 0, picInfo: { id: 'synthetic-picture', width: 2, height: 3 } };
      },
      publishGroupBulletin(...args) {
        assert.equal(this, group);
        calls.push(['publish', ...args]);
        return { result: 0 };
      },
      deleteGroupBulletin(...args) {
        assert.equal(this, group);
        calls.push(['delete', ...args]);
        return undefined;
      },
    };
    const services = createNativeServices({
      session: {
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => group,
        getTipOffService: () => tip,
      },
      version: '7.0.2-53644',
      identity: { userId: '123', uid: 'u_fixture' },
      events: { emit() {} },
    });
    return { services, tip, group, calls };
  };
  const cli = fixture();
  try {
    const facade = {
      publishGroupNotice: (groupId, text, options) =>
        cli.services.invokeOperation('publishGroupNotice', { groupId, text, options }),
      deleteGroupNotice: (groupId, noticeId) =>
        cli.services.invokeOperation('deleteGroupNotice', { groupId, noticeId }),
    };
    await (
      await prepareCommand('group-notice-publish', { 'group-id': '123', text: 'a b/中文' })
    )(facade);
    await (
      await prepareCommand('group-notice-delete', { 'group-id': '123', 'notice-id': 'notice' })
    )(facade);
    assert.deepEqual(cli.calls, [
      ['ticket', ['qun.qq.com'], true],
      [
        'publish',
        '123',
        'synthetic-key',
        {
          text: encodeURI('a b/中文'),
          picInfo: undefined,
          oldFeedsId: '',
          pinned: 0,
          confirmRequired: 0,
        },
      ],
      ['ticket', ['qun.qq.com'], true],
      ['delete', '123', 'synthetic-key', 'notice'],
    ]);
  } finally {
    cli.services.close();
  }
  const frozen = fixture(),
    pendingTicket = deferred();
  frozen.tip.getPskey = function (...args) {
    frozen.calls.push(['ticket', ...args]);
    return pendingTicket.promise;
  };
  try {
    const options = { pinned: true, confirmRequired: false };
    const payload = { groupId: '123', text: 'captured', options };
    const pending = frozen.services.invokeOperation('publishGroupNotice', payload);
    payload.text = 'changed';
    options.pinned = false;
    options.confirmRequired = true;
    pendingTicket.resolve(ticket());
    await pending;
    assert.equal(frozen.calls[1][3].text, 'captured');
    assert.equal(frozen.calls[1][3].pinned, 1);
    assert.equal(frozen.calls[1][3].confirmRequired, 0);
  } finally {
    frozen.services.close();
  }
  const invalid = fixture();
  try {
    for (const payload of [
      { groupId: 123, text: '' },
      { groupId: '123', text: 1 },
      { groupId: '123', text: '', options: { pinned: 'yes' } },
    ])
      await assert.rejects(invalid.services.invokeOperation('publishGroupNotice', payload));
    assert.equal(invalid.calls.length, 0);
  } finally {
    invalid.services.close();
  }
  for (const value of [
    { result: 7 },
    { result: 0, domainPskeyMap: {} },
    { result: 0, domainPskeyMap: new Map() },
  ]) {
    const f = fixture();
    f.tip.getPskey = () => value;
    try {
      await assert.rejects(
        f.services.invokeOperation('deleteGroupNotice', { groupId: '123', noticeId: 'id' }),
      );
      assert.equal(f.calls.length, 0);
    } finally {
      f.services.close();
    }
  }
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'qq-notice-contract-')));
  const path = join(directory, 'image.bin'),
    bytes = Buffer.from('controlled local image');
  await writeFile(path, bytes);
  try {
    const image = fixture();
    try {
      await image.services.invokeOperation('publishGroupNotice', {
        groupId: '123',
        text: '',
        options: { imagePath: path, pinned: true, confirmRequired: true },
      });
      assert.deepEqual(image.calls[1], ['upload', '123', 'synthetic-key', path]);
      assert.deepEqual(image.calls[2][3].picInfo, { id: 'synthetic-picture', width: 2, height: 3 });
      assert.deepEqual(await readFile(path), bytes);
    } finally {
      image.services.close();
    }
    for (const stage of ['ticket', 'upload']) {
      const f = fixture(),
        response = deferred(),
        began = deferred();
      if (stage === 'ticket')
        f.tip.getPskey = () => {
          began.resolve();
          return response.promise;
        };
      else
        f.group.uploadGroupBulletinPic = (...args) => {
          f.calls.push(['upload', ...args]);
          began.resolve();
          return response.promise;
        };
      const pending = f.services.invokeOperation('publishGroupNotice', {
        groupId: '123',
        text: '',
        options: { imagePath: path },
      });
      await settleWithin(began.promise);
      f.services.close();
      await assert.rejects(settleWithin(pending), /closed|abort/i);
      response.reject(new Error('Late controlled failure'));
      await turn();
      assert.equal(f.calls.filter(([method]) => method === 'publish').length, 0);
      assert.equal(
        f.calls.filter(([method]) => method === 'upload').length,
        stage === 'upload' ? 1 : 0,
      );
    }
    for (const stage of ['result', 'metadata']) {
      const f = fixture();
      if (stage === 'result')
        f.group.deleteGroupBulletin = () => ({
          get result() {
            f.services.close();
            return 0;
          },
        });
      else
        f.group.uploadGroupBulletinPic = () => ({
          result: 0,
          errCode: 0,
          picInfo: {
            get id() {
              f.services.close();
              return 'picture';
            },
            width: 2,
            height: 3,
          },
        });
      try {
        await assert.rejects(
          settleWithin(
            f.services.invokeOperation(
              stage === 'result' ? 'deleteGroupNotice' : 'publishGroupNotice',
              { groupId: '123', noticeId: 'id', text: '', options: { imagePath: path } },
            ),
          ),
          /closed|abort/i,
        );
        assert.equal(f.calls.filter(([method]) => method === 'publish').length, 0);
      } finally {
        f.services.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return {
    groupNoticePortContract: true,
    groupNoticeCliContract: true,
    groupNoticeSnapshotContract: true,
    groupNoticePendingCloseContract: true,
    groupNoticeLateFailureObserved: true,
    groupNoticeImagePreserved: true,
    groupNoticeReentrantCloseContract: true,
    nativeExecuted: false,
    accountUsed: false,
  };
}
