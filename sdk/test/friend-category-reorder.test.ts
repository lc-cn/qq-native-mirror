import assert from 'node:assert/strict';
import test from 'node:test';
import { createFriendCategoryMutations } from '../src/features/contacts/friend-category-mutations.ts';
import { captureFriendCategoryOrder } from '../src/features/contacts/friend-category-input.ts';

const rows = () => [
  { categoryId: 0xffff_ffff, name: ' exact 中文 ' },
  { categoryId: 0, name: '' },
];
test('reorder captures indexed rows without executing a custom iterator', () => {
  const input = rows();
  Object.defineProperty(input, Symbol.iterator, {
    get() {
      throw Error('Iterator must not execute');
    },
  });
  assert.deepEqual(captureFriendCategoryOrder(input), rows());
});

test('reorder rejects sparse, inherited, and accessor indices without executing them', () => {
  const sparse = Array(1);
  Object.defineProperty(sparse, Symbol.iterator, {
    value: function* () {
      yield { categoryId: 1, name: 'hidden hole' };
    },
  });
  const inherited = Array(1);
  Object.setPrototypeOf(inherited, { 0: { categoryId: 1, name: 'inherited' } });
  const accessor = Array(1);
  Object.defineProperty(accessor, '0', {
    get() {
      throw Error('Index accessor must not execute');
    },
  });
  for (const input of [sparse, inherited, accessor])
    assert.throws(() => captureFriendCategoryOrder(input), /dense data rows/);
});

test('reorder captures the explicit snapshot before acquisition and calls one vector with its original receiver', async () => {
  const source = rows();
  let reads = 0;
  const calls: unknown[][] = [];
  const buddy = {
    get resortCategory() {
      reads++;
      return function (this: unknown, ...args: unknown[]) {
        assert.equal(this, buddy);
        calls.push(args);
        return { result: 0 };
      };
    },
  };
  const owner = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => false,
    canRename: () => false,
    canDelete: () => false,
    canReorder: () => true,
    getBuddyService() {
      source[0]!.name = 'changed during acquisition';
      source.reverse();
      return buddy;
    },
  });
  await owner.reorder(source);
  assert.equal(reads, 1);
  assert.deepEqual(calls, [
    [
      [
        { categoryId: 0xffff_ffff, categroyName: ' exact 中文 ' },
        { categoryId: 0, categroyName: '' },
      ],
    ],
  ]);
  owner.close();
});

test('reorder rejects missing/sparse/duplicate/coerced rows and accessors before acquiring Buddy', async () => {
  let acquisitions = 0;
  const owner = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => false,
    canRename: () => false,
    canDelete: () => false,
    canReorder: () => true,
    getBuddyService() {
      acquisitions++;
      return {};
    },
  });
  for (const input of [
    undefined,
    [],
    Array(1),
    [null],
    [{ categoryId: '1', name: 'x' }],
    [{ categoryId: -1, name: 'x' }],
    [{ categoryId: 0x1_0000_0000, name: 'x' }],
    [{ categoryId: 1.5, name: 'x' }],
    [{ categoryId: 1 }],
    [{ categoryId: 1, name: 2 }],
    [
      { categoryId: 1, name: 'x' },
      { categoryId: 1, name: 'y' },
    ],
    [
      {
        categoryId: 1,
        get name() {
          throw Error('Accessor must not execute');
        },
      },
    ],
  ]) {
    await assert.rejects(owner.reorder(input));
  }
  assert.equal(acquisitions, 0);
  const snapshot = captureFriendCategoryOrder(rows());
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot[0]));
  owner.close();
});

test('unsupported reorder does not acquire the service or native method', async () => {
  let acquisitions = 0;
  const owner = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => true,
    canRename: () => true,
    canDelete: () => true,
    canReorder: () => false,
    getBuddyService() {
      acquisitions++;
      throw Error('Must not acquire');
    },
  });
  await assert.rejects(owner.reorder(rows()), { code: 'unsupported-native-contract' });
  assert.equal(acquisitions, 0);
  owner.close();
});

test('reorder rejects resolved native failure and malformed ACKs without reading native wording', async () => {
  for (const result of [
    undefined,
    null,
    [],
    { result: '0' },
    { result: NaN },
    { result: 0x8000_0000 },
    {
      get result() {
        throw Error('Accessor must not execute');
      },
    },
    {
      result: -7,
      get errMsg() {
        throw Error('Wording must not execute');
      },
    },
  ]) {
    let calls = 0;
    const owner = createFriendCategoryMutations({
      signal: new AbortController().signal,
      canCreate: () => false,
      canRename: () => false,
      canDelete: () => false,
      canReorder: () => true,
      getBuddyService: () => ({
        resortCategory() {
          calls++;
          return result;
        },
      }),
    });
    await assert.rejects(owner.reorder(rows()));
    assert.equal(calls, 1);
    owner.close();
  }
});

test('closing during native method acquisition prevents reorder dispatch', async () => {
  let calls = 0;
  const owner = createFriendCategoryMutations({
    signal: new AbortController().signal,
    canCreate: () => false,
    canRename: () => false,
    canDelete: () => false,
    canReorder: () => true,
    getBuddyService: () => ({
      get resortCategory() {
        owner.close();
        return () => {
          calls++;
          return { result: 0 };
        };
      },
    }),
  });
  await assert.rejects(owner.reorder(rows()), /closed/);
  assert.equal(calls, 0);
});

test('reorder close and deadline leave remote effect unknown, observe late rejection, and never replay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stop of ['close', 'deadline']) {
    let calls = 0;
    let reject!: (error: Error) => void;
    const owner = createFriendCategoryMutations({
      signal: new AbortController().signal,
      canCreate: () => false,
      canRename: () => false,
      canDelete: () => false,
      canReorder: () => true,
      getBuddyService: () => ({
        resortCategory() {
          calls++;
          return new Promise((_, fail) => {
            reject = fail;
          });
        },
      }),
    });
    const checked = assert.rejects(owner.reorder(rows()), /remote effect unknown/);
    if (stop === 'close') owner.close();
    else t.mock.timers.tick(5001);
    await checked;
    reject(Error('late native rejection'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    owner.close();
  }
});
