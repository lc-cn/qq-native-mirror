import assert from 'node:assert/strict';
import test from 'node:test';
import { createFriendCategoryRename } from '../src/features/contacts/friend-category-rename.ts';

test('exact two arguments and receiver; uint32 zero accepted without assuming business effect', async () => {
  const calls: unknown[][] = [];
  const service = {
    renameCategory(id: number, name: string) {
      assert.equal(this, service);
      calls.push([id, name]);
      return { result: 0, errMsg: 'private' };
    },
  };
  const api = createFriendCategoryRename({
    signal: new AbortController().signal,
    getBuddyService: () => service,
  });
  assert.equal(await api.rename(0, ' new '), undefined);
  await api.rename(0xffff_ffff, 'last');
  assert.deepEqual(calls, [
    [0, ' new '],
    [0xffff_ffff, 'last'],
  ]);
  api.close();
});

test('invalid input and service getter retirement prevent native dispatch', async () => {
  let calls = 0,
    getters = 0;
  const api = createFriendCategoryRename({
    signal: new AbortController().signal,
    getBuddyService: () => {
      getters++;
      api.close();
      return {
        renameCategory() {
          calls++;
        },
      };
    },
  });
  for (const id of [-1, 1.5, NaN, 0x1_0000_0000]) await assert.rejects(api.rename(id, 'name'));
  await assert.rejects(api.rename(1, ' '));
  assert.equal(getters, 0);
  await assert.rejects(api.rename(1, 'name'), /closed/);
  assert.equal(calls, 0);
});

test('method getter abort prevents dispatch and original native rejection is preserved', async () => {
  const controller = new AbortController(),
    reason = new Error('retired');
  let calls = 0;
  const service = {
    get renameCategory() {
      controller.abort(reason);
      return () => {
        calls++;
      };
    },
  };
  const api = createFriendCategoryRename({
    signal: controller.signal,
    getBuddyService: () => service,
  });
  await assert.rejects(api.rename(1, 'name'), (error) => error === reason);
  assert.equal(calls, 0);
  const original = new Error('native rejected');
  const failing = createFriendCategoryRename({
    signal: new AbortController().signal,
    getBuddyService: () => ({
      renameCategory() {
        calls++;
        return Promise.reject(original);
      },
    }),
  });
  await assert.rejects(failing.rename(1, 'name'), (error) => error === original);
  assert.equal(calls, 1);
  failing.close();
});

test('close settles pending write unknown and observes late rejection without retries', async () => {
  let reject!: (error: unknown) => void,
    calls = 0;
  const api = createFriendCategoryRename({
    signal: new AbortController().signal,
    getBuddyService: () => ({
      renameCategory() {
        calls++;
        return new Promise((_, fail) => {
          reject = fail;
        });
      },
    }),
  });
  const pending = api.rename(2, 'name');
  const checked = assert.rejects(pending, /remote effect unknown/);
  api.close();
  await checked;
  reject(new Error('late failure'));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(api.rename(2, 'name'), /closed/);
  assert.equal(calls, 1);
});

test('malformed and nonzero ACK never disclose native wording', async () => {
  for (const result of [
    undefined,
    { result: '0' },
    { result: 1, errMsg: 'private' },
    {
      get result() {
        throw new Error('private');
      },
    },
  ]) {
    const api = createFriendCategoryRename({
      signal: new AbortController().signal,
      getBuddyService: () => ({ renameCategory: () => result }),
    });
    await assert.rejects(
      api.rename(1, 'name'),
      (error) => error instanceof Error && !error.message.includes('private'),
    );
    api.close();
  }
});

test('synchronous close during dispatch with resolved ACK retains unknown effect', async () => {
  let calls = 0;
  const api = createFriendCategoryRename({
    signal: new AbortController().signal,
    getBuddyService: () => ({
      renameCategory() {
        calls++;
        api.close();
        return { result: 0 };
      },
    }),
  });
  await assert.rejects(api.rename(1, 'name'), /remote effect unknown/);
  assert.equal(calls, 1);
});

test('close during result descriptor projection retains unknown effect', async () => {
  let calls = 0;
  const result = new Proxy(
    { result: 0 },
    {
      getOwnPropertyDescriptor(target, key) {
        api.close();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  const api = createFriendCategoryRename({
    signal: new AbortController().signal,
    getBuddyService: () => ({
      renameCategory() {
        calls++;
        return result;
      },
    }),
  });
  await assert.rejects(api.rename(1, 'name'), /remote effect unknown/);
  assert.equal(calls, 1);
});

test('five second deadline settles once without replay and observes late rejection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0,
    reject!: (error: unknown) => void;
  const api = createFriendCategoryRename({
    signal: new AbortController().signal,
    getBuddyService: () => ({
      renameCategory() {
        calls++;
        return new Promise((_, fail) => {
          reject = fail;
        });
      },
    }),
  });
  const pending = api.rename(1, 'name');
  const checked = assert.rejects(pending, /timed out; remote effect unknown/);
  t.mock.timers.tick(4999);
  await Promise.resolve();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await checked;
  reject(new Error('late rejection'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  api.close();
});
