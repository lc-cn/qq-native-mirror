import assert from 'node:assert/strict';
import test from 'node:test';
import { createFriendCategoryMutations } from '../src/features/contacts/friend-category-mutations.ts';

test('creation captures method once, keeps receiver and explicit undefined argument', async () => {
  let reads = 0;
  const calls: unknown[][] = [];
  const service = {
    get addCategoryV2() {
      reads++;
      return function (this: unknown, ...args: unknown[]) {
        assert.equal(this, service);
        calls.push(args);
        return { result: 0, groupId: 12, name: 'native' };
      };
    },
  };
  const owner = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => true,
    canRename: () => false,
    canDelete: () => false,
    getBuddyService: () => service,
  });
  assert.deepEqual(await owner.create(' supplied '), { categoryId: 12, name: 'native' });
  assert.equal(reads, 1);
  assert.deepEqual(calls, [[' supplied ', undefined]]);
  owner.close();
});

test('creation validates input and capability before acquisition', async () => {
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
  await assert.rejects(owner.create(' '), /nonblank/);
  await assert.rejects(owner.create('valid'), /creation contract is not verified/);
  assert.equal(acquisitions, 0);
  owner.close();
});

test('creation getter close prevents dispatch after one capture', async () => {
  let reads = 0;
  let calls = 0;
  const owner = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => true,
    canRename: () => false,
    canDelete: () => false,
    getBuddyService: () => ({
      get addCategoryV2() {
        reads++;
        owner.close();
        return () => {
          calls++;
        };
      },
    }),
  });
  await assert.rejects(owner.create('name'), /closed/);
  assert.equal(reads, 1);
  assert.equal(calls, 0);
});

test('creation pending close observes late rejection without retry', async () => {
  let reject!: (error: unknown) => void;
  let calls = 0;
  const owner = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => true,
    canRename: () => false,
    canDelete: () => false,
    getBuddyService: () => ({
      addCategoryV2() {
        calls++;
        return new Promise((_, fail) => {
          reject = fail;
        });
      },
    }),
  });
  const checked = assert.rejects(owner.create('name'), /creation; remote effect unknown/);
  owner.close();
  await checked;
  reject(new Error('late'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('creation receipt projection close cannot publish DTO, including descriptor throw', async () => {
  for (const throws of [false, true]) {
    const result = new Proxy(
      { result: 0, groupId: 12, name: 'native' },
      {
        getOwnPropertyDescriptor(target, key) {
          owner.close();
          if (throws) throw new Error('private descriptor error');
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const owner = createFriendCategoryMutations({
      signal: new AbortController().signal,
      canCreate: () => true,
      canRename: () => false,
      canDelete: () => false,
      getBuddyService: () => ({ addCategoryV2: () => result }),
    });
    await assert.rejects(owner.create('name'), /creation; remote effect unknown/);
  }
});
