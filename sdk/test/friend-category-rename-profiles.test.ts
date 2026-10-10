import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import test from 'node:test';
import { createNativeServices } from '../src/native-services.ts';
import { QQClient } from '../src/index.ts';
import { prepareCommand, validateCommandFlags } from '../src/cli/command-plan.ts';
import {
  supportsCategoryRenaming,
  type NativeContractProfile,
} from '../src/native/native-contracts.ts';

const profiles = (
  JSON.parse(
    readFileSync(new URL('../docs/evidence/group-search-contract.json', import.meta.url), 'utf8'),
  ) as { profiles: NativeContractProfile[] }
).profiles;

function fixture(
  profile: NativeContractProfile | undefined,
  version = profile?.clientVersion ?? 'unknown',
) {
  let acquired = 0;
  const calls: unknown[][] = [];
  const buddy = {
    addKernelBuddyListener() {},
    renameCategory(...args: unknown[]) {
      assert.equal(this, buddy);
      assert.equal(args.length, 2);
      calls.push(args);
      return { result: 0 };
    },
  };
  const services = createNativeServices({
    session: {
      getBuddyService() {
        acquired++;
        return buddy;
      },
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
    },
    version,
    binaryProfile: profile,
    events: { emit() {} },
  });
  acquired = 0;
  return { services, calls, acquired: () => acquired };
}

test('rename enables only both exact Linux binaries and preserves uint32, spelling, receiver and two arguments', async () => {
  assert.equal(profiles.length, 6);
  for (const profile of profiles) {
    assert.equal(
      supportsCategoryRenaming(profile, profile.clientVersion),
      profile.platform === 'linux',
    );
    const f = fixture(profile);
    try {
      if (profile.platform === 'linux') {
        assert.equal(
          await f.services.invokeOperation('renameFriendCategory', {
            categoryId: 0xffff_ffff,
            name: ' new ',
          }),
          undefined,
        );
        assert.deepEqual(f.calls, [[0xffff_ffff, ' new ']]);
      } else {
        await assert.rejects(
          f.services.invokeOperation('renameFriendCategory', { categoryId: 1, name: 'new' }),
          /not verified|unsupported/i,
        );
        assert.equal(f.acquired(), 0);
        assert.deepEqual(f.calls, []);
      }
    } finally {
      f.services.close();
    }
  }
});

test('missing and mismatched provenance or invalid input cannot acquire Buddy or rename', async () => {
  const linux = profiles.find((p) => p.platform === 'linux')!;
  for (const profile of [
    undefined,
    ...(['platform', 'arch', 'clientVersion', 'wrapperSha256'] as const).map((key) => ({
      ...linux,
      [key]: 'unknown',
    })),
  ]) {
    const f = fixture(profile);
    try {
      await assert.rejects(
        f.services.invokeOperation('renameFriendCategory', { categoryId: 1, name: 'new' }),
      );
      assert.equal(f.acquired(), 0);
      assert.deepEqual(f.calls, []);
    } finally {
      f.services.close();
    }
  }
  const mismatch = fixture(linux, 'wrong-version');
  try {
    await assert.rejects(
      mismatch.services.invokeOperation('renameFriendCategory', { categoryId: 1, name: 'new' }),
    );
    assert.equal(mismatch.acquired(), 0);
  } finally {
    mismatch.services.close();
  }
  const f = fixture(linux);
  try {
    for (const categoryId of [-1, 1.5, NaN, 0x1_0000_0000, '1'])
      await assert.rejects(
        f.services.invokeOperation('renameFriendCategory', { categoryId, name: 'new' }),
      );
    await assert.rejects(
      f.services.invokeOperation('renameFriendCategory', { categoryId: 1, name: ' ' }),
    );
    assert.equal(f.acquired(), 0);
    assert.deepEqual(f.calls, []);
  } finally {
    f.services.close();
  }
});

test('public facade and prepared CLI dispatch captured numeric ID and untrimmed name once', async () => {
  const worker = new EventEmitter();
  const calls: { method: string; categoryId?: number; name?: string }[] = [];
  Object.assign(worker, {
    connected: true,
    exitCode: null,
    send(
      value: { id: number; method: string; categoryId?: number; name?: string },
      callback: (error: Error | null) => void,
    ) {
      callback(null);
      calls.push(value);
      queueMicrotask(() => worker.emit('message', { id: value.id, result: undefined }));
    },
  });
  const client = new QQClient(worker as unknown as ChildProcess, 500);
  worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'fixture' } });
  await client.renameFriendCategory(0, ' exact ');
  assert.deepEqual(
    { categoryId: calls[0].categoryId, name: calls[0].name },
    { categoryId: 0, name: ' exact ' },
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
  assert.throws(() =>
    validateCommandFlags('friend-category-rename', {
      'category-id': '1',
      name: 'new',
      unexpected: 'x',
    }),
  );
  assert.equal(calls.length, 2);
  Object.assign(worker, { connected: false, exitCode: 0 });
  worker.emit('exit', 0, null);
  await client.close();
});
