import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Compiled package contracts with controlled services; no QQ operation. */
export async function verifyFriendCategoryMutationsConsumer(packageRoot) {
  const load = (path) => import(pathToFileURL(join(packageRoot, 'dist', path)).href);
  const { createNativeServices } = await load('native-services.js');
  const { QQClient } = await load('index.js');
  const { prepareCommand } = await load('cli.js');
  const { profiles } = JSON.parse(
    await readFile(join(packageRoot, 'docs/evidence/group-search-contract.json'), 'utf8'),
  );
  const { profiles: verifiedProfiles } = JSON.parse(
    await readFile(join(packageRoot, 'docs/evidence/friend-category-rename-contract.json'), 'utf8'),
  );
  const matches = (a, b) =>
    a &&
    b &&
    ['platform', 'arch', 'clientVersion', 'wrapperSha256'].every((key) => a[key] === b[key]);
  const isVerified = (profile) => verifiedProfiles.some((p) => matches(p, profile));
  assert.equal(verifiedProfiles.length, 4);
  assert.equal(profiles.length, 6);
  const { profiles: deleteProfiles } = JSON.parse(
    await readFile(join(packageRoot, 'docs/evidence/friend-category-delete-contract.json'), 'utf8'),
  );
  assert.equal(deleteProfiles.length, 3);
  const { profiles: reorderProfiles } = JSON.parse(
    await readFile(
      join(packageRoot, 'docs/evidence/friend-category-reorder-contract.json'),
      'utf8',
    ),
  );
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
    const calls = [];
    const buddy = {
      addKernelBuddyListener() {},
      renameCategory(...args) {
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
    const deleted = [];
    const buddy = {
      addKernelBuddyListener() {},
      delCategory(...args) {
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
  const reorderCases = [
    ...profiles.map((profile) => [profile, profile.clientVersion]),
    [undefined, 'unknown'],
    [reorderProfiles[0], 'wrong-version'],
    ...['platform', 'arch', 'clientVersion', 'wrapperSha256'].map((key) => [
      { ...reorderProfiles[0], [key]: 'unverified' },
      reorderProfiles[0].clientVersion,
    ]),
  ];
  for (const [profile, version] of reorderCases) {
    let acquisitions = 0;
    const calls = [];
    const buddy = {
      addKernelBuddyListener() {},
      resortCategory(...args) {
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
  const worker = new EventEmitter(),
    calls = [];
  Object.assign(worker, {
    connected: true,
    exitCode: null,
    send(value, callback) {
      calls.push(value);
      callback(null);
      queueMicrotask(() => worker.emit('message', { id: value.id, result: undefined }));
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
    await assert.rejects(client.reorderFriendCategories([{ categoryId: '1', name: 'invalid' }]));
    assert.equal(calls.length, 6);
  } finally {
    Object.assign(worker, { connected: false, exitCode: 0 });
    worker.emit('exit', 0, null);
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
  return {
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
