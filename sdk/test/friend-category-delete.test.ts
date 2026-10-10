import assert from 'node:assert/strict';
import test from 'node:test';
import { createFriendCategoryMutations } from '../src/features/contacts/friend-category-mutations.ts';

test('delete sends one uint32 argument with original receiver and zero/max ACK only', async () => {
  const calls: unknown[][] = [];
  const service = {
    delCategory(...args: number[]) {
      assert.equal(this, service);
      calls.push(args);
      return { result: 0 };
    },
  };
  const owner = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => false,
    canRename: () => true,
    canDelete: () => true,
    getBuddyService: () => service,
  });
  await owner.delete(0);
  await owner.delete(0xffff_ffff);
  assert.deepEqual(calls, [[0], [0xffff_ffff]]);
  owner.close();
});

test('invalid input and unsupported capability reject before acquisition', async () => {
  let acquisitions = 0;
  const owner = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => false,
    canRename: () => false,
    canDelete: () => false,
    getBuddyService: () => {
      acquisitions++;
      return {};
    },
  });
  for (const id of ['1', -1, NaN, 1.5, 0x1_0000_0000])
    await assert.rejects(owner.delete(id), /uint32/);
  for (const pending of [owner.delete(1), owner.rename(1, 'name')])
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'unsupported-native-contract',
    );
  assert.equal(acquisitions, 0);
  owner.close();
});

test('delete getter closes before dispatch and missing method has fixed wording', async () => {
  let calls = 0;
  const owner = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => false,
    canRename: () => true,
    canDelete: () => true,
    getBuddyService: () => ({
      get delCategory() {
        owner.close();
        return () => {
          calls++;
        };
      },
    }),
  });
  await assert.rejects(owner.delete(1), /closed/);
  assert.equal(calls, 0);
  const missing = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => false,
    canRename: () => true,
    canDelete: () => true,
    getBuddyService: () => null,
  });
  await assert.rejects(missing.delete(1), /Missing native method delCategory/);
  missing.close();
});

test('delete requires int32 zero status; native rejection identity and no retry', async () => {
  for (const result of [
    undefined,
    { result: '0' },
    { result: 0x8000_0000 },
    { result: -1, errMsg: 'secret' },
  ]) {
    let calls = 0;
    const owner = createFriendCategoryMutations({
      signal: new AbortController().signal,
      canCreate: () => false,
      canRename: () => true,
      canDelete: () => true,
      getBuddyService: () => ({
        delCategory() {
          calls++;
          return result;
        },
      }),
    });
    await assert.rejects(
      owner.delete(1),
      (error: unknown) => error instanceof Error && !error.message.includes('secret'),
    );
    assert.equal(calls, 1);
    owner.close();
  }
  const original = new Error('original');
  const owner = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => false,
    canRename: () => true,
    canDelete: () => true,
    getBuddyService: () => ({ delCategory: () => Promise.reject(original) }),
  });
  await assert.rejects(owner.delete(1), (error) => error === original);
  owner.close();
});

test('delete close observes late failure and cannot publish resolved ACK after dispatch closes', async () => {
  let reject!: (error: unknown) => void;
  const owner = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => false,
    canRename: () => true,
    canDelete: () => true,
    getBuddyService: () => ({
      delCategory: () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    }),
  });
  const checked = assert.rejects(owner.delete(1), /delete; remote effect unknown/);
  owner.close();
  await checked;
  reject(new Error('late'));
  await new Promise((resolve) => setImmediate(resolve));
  const reentrant = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => false,
    canRename: () => true,
    canDelete: () => true,
    getBuddyService: () => ({
      delCategory() {
        reentrant.close();
        return { result: 0 };
      },
    }),
  });
  await assert.rejects(reentrant.delete(1), /delete; remote effect unknown/);
});

test('delete deadline observes late rejection and never retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let reject!: (error: unknown) => void;
  const owner = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => false,
    canRename: () => true,
    canDelete: () => true,
    getBuddyService: () => ({
      delCategory() {
        calls++;
        return new Promise((_, fail) => {
          reject = fail;
        });
      },
    }),
  });
  const checked = assert.rejects(owner.delete(1), /delete timed out; remote effect unknown/);
  t.mock.timers.tick(5000);
  await checked;
  reject(new Error('late'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  owner.close();
});

test('delete result descriptor retirement prevents success', async () => {
  const result = new Proxy(
    { result: 0 },
    {
      getOwnPropertyDescriptor(target, key) {
        owner.close();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  const owner = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => false,
    canRename: () => true,
    canDelete: () => true,
    getBuddyService: () => ({ delCategory: () => result }),
  });
  await assert.rejects(owner.delete(1), /delete; remote effect unknown/);
});
