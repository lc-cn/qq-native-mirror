import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGroupNotices } from '../src/features/groups/group-notices.ts';
import { createNativeServices } from '../src/native-services.ts';

test('worker notice input rejects unknown group identifiers before acquiring a ticket', async () => {
  let acquisitions = 0;
  let coercions = 0;
  const services = createNativeServices({
    session: {
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getTipOffService() {
        acquisitions++;
        throw new Error('unexpected ticket acquisition');
      },
    },
    identity: { userId: '123', uid: 'u_fixture' },
    version: 'fixture',
    events: { emit() {} },
  });
  try {
    for (const groupId of [
      123,
      undefined,
      null,
      {
        toString() {
          coercions++;
          return '123';
        },
      },
    ])
      await assert.rejects(
        services.invokeOperation('listGroupNotices', { groupId }),
        /numeric strings/,
      );
    assert.equal(acquisitions, 0);
    assert.equal(coercions, 0);
  } finally {
    services.close();
  }
});
function fixture() {
  const calls: any[][] = [];
  const group = {
    publishGroupBulletin: (...args: unknown[]) => {
      calls.push(['publish', ...args]);
      return { result: 0 };
    },
    uploadGroupBulletinPic: (...args: unknown[]) => {
      calls.push(['upload', ...args]);
      return { result: 0, errCode: 0, picInfo: { id: 'image-id', width: 1, height: 2 } };
    },
    deleteGroupBulletin: (...args: unknown[]) => {
      calls.push(['delete', ...args]);
      return undefined as unknown;
    },
  };
  const tipoff = {
    getPskey: (...args: unknown[]) => {
      calls.push(['key', ...args]);
      return { result: 0, domainPskeyMap: new Map([['qun.qq.com', 'private-key']]) };
    },
  };
  return {
    calls,
    group,
    tipoff,
    module: createGroupNotices({ getGroupService: () => group, getTipOffService: () => tipoff }),
  };
}

test('native dispatcher integrates notice operations and never exposes the domain ticket', async () => {
  const f = fixture(),
    events: unknown[] = [];
  const services = createNativeServices({
    session: {
      getGroupService: () => ({
        ...f.group,
        addKernelGroupListener() {
          return 1;
        },
        removeKernelGroupListener() {},
      }),
      getTipOffService: () => f.tipoff,
      getBuddyService: () => ({
        addKernelBuddyListener() {
          return 1;
        },
        removeKernelBuddyListener() {},
      }),
      getMsgService: () => ({
        addKernelMsgListener() {
          return 1;
        },
        removeKernelMsgListener() {},
      }),
    },
    version: '3.2.32-52194',
    events: {
      emit: (...args) => {
        events.push(args);
      },
    },
  });
  assert.equal(f.calls.length, 0, 'constructing services never obtains a domain ticket');
  assert.equal(
    await services.invokeOperation('publishGroupNotice', { groupId: '123', text: 'fixture' }),
    undefined,
  );
  assert.equal(
    await services.invokeOperation('deleteGroupNotice', { groupId: '123', noticeId: 'notice_42' }),
    undefined,
  );
  assert.deepEqual(events, [], 'publication and deletion emit no credential-bearing result');
  services.close();
  const previousCalls = f.calls.length;
  await assert.rejects(
    services.invokeOperation('deleteGroupNotice', { groupId: '123', noticeId: 'notice_42' }),
    /closed/,
  );
  assert.equal(f.calls.length, previousCalls, 'closed dispatcher never requests another ticket');
});

test('native text notice uses domain pskey, encodeURI and exact publish contract', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  await f.module.invokeOperation('publishGroupNotice', {
    groupId: '123',
    text: '中文 & #',
    options: { pinned: true },
  });
  assert.deepEqual(f.calls, [
    ['key', ['qun.qq.com'], true],
    [
      'publish',
      '123',
      'private-key',
      {
        text: encodeURI('中文 & #'),
        picInfo: undefined,
        oldFeedsId: '',
        pinned: 1,
        confirmRequired: 0,
      },
    ],
  ]);
});

test('notice image upload verifies metadata and preserves user local file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'qq-notice-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'image.png');
  const data = Buffer.from('fixture content for native upload');
  await writeFile(path, data);
  const f = fixture();
  await f.module.invokeOperation('publishGroupNotice', {
    groupId: '123',
    text: 'image notice',
    options: { imagePath: path, confirmRequired: true },
  });
  assert.equal(f.calls[1][0], 'upload');
  assert.equal(f.calls[1][3], await realpath(path));
  assert.deepEqual(f.calls[2][3].picInfo, { id: 'image-id', width: 1, height: 2 });
  assert.equal(f.calls[2][3].confirmRequired, 1);
  assert.deepEqual(await readFile(path), data);
  f.group.uploadGroupBulletinPic = () => ({
    result: 0,
    errCode: 17,
    picInfo: { id: 'image-id', width: 1, height: 2 },
  });
  await assert.rejects(
    f.module.invokeOperation('publishGroupNotice', {
      groupId: '123',
      text: 'upload failed',
      options: { imagePath: path },
    }),
    { code: 17 },
  );
  f.group.uploadGroupBulletinPic = () => ({
    result: 0,
    errCode: 0,
    picInfo: { id: '', width: 0, height: 2 },
  });
  await assert.rejects(
    f.module.invokeOperation('publishGroupNotice', {
      groupId: '123',
      text: 'bad',
      options: { imagePath: path },
    }),
    /invalid picture/,
  );
  assert.equal(
    f.calls.filter((call) => call[0] === 'publish').length,
    1,
    'bad upload never publishes',
  );
});

test('deletion preserves exact pskey/noticeId call and treats void as dispatch only', async () => {
  const f = fixture();
  await f.module.invokeOperation('deleteGroupNotice', { groupId: '123', noticeId: 'fid_opaque' });
  assert.deepEqual(f.calls, [
    ['key', ['qun.qq.com'], true],
    ['delete', '123', 'private-key', 'fid_opaque'],
  ]);
  f.group.deleteGroupBulletin = () => ({ result: 5 });
  await assert.rejects(
    f.module.invokeOperation('deleteGroupNotice', { groupId: '123', noticeId: 'fid' }),
    { message: /failed/, code: 5 },
  );
});

test('invalid input and ticket failures never invoke native publication', async () => {
  const f = fixture();
  for (const payload of [
    { groupId: 'bad', text: 'a' },
    { groupId: '123', text: 1 },
    { groupId: '123', text: 'a', options: { pinned: 1 } },
    { groupId: '123', text: 'a', options: { imagePath: 'https://example.test/a.png' } },
  ])
    await assert.rejects(f.module.invokeOperation('publishGroupNotice', payload));
  assert.equal(f.calls.length, 0);
  f.tipoff.getPskey = () => ({ result: 0, domainPskeyMap: new Map() });
  await assert.rejects(
    f.module.invokeOperation('publishGroupNotice', { groupId: '123', text: 'a' }),
    /domain key/,
  );
  assert.equal(f.calls.length, 0);
});
