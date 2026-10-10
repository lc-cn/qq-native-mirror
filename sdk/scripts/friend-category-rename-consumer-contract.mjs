import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Compiled package contracts with controlled services; no QQ operation. */
export async function verifyFriendCategoryRenameConsumer(packageRoot) {
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
  assert.equal(verifiedProfiles.length, 3);
  assert.equal(profiles.length, 6);
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
  } finally {
    Object.assign(worker, { connected: false, exitCode: 0 });
    worker.emit('exit', 0, null);
    await client.close();
  }
  return {
    friendCategoryRenameBinaryGateContract: true,
    friendCategoryRenameCompositionContract: true,
    friendCategoryRenameFacadeContract: true,
    friendCategoryRenameCliContract: true,
    nativeFriendCategoryRenameAttempted: false,
    accountUsed: false,
  };
}
