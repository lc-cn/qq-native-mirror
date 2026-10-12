import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroupFiles } from '../../../src/features/groups/files/group-files.ts';
import { NativeServiceLifetime } from '../../../src/runtime/native-service-lifetime.ts';

type Files = ReturnType<typeof createGroupFiles>;
const actions = {
  count: (files: Files) => files.getGroupFileCount('123'),
  create: (files: Files) => files.createGroupFolder('123', 'folder'),
  delete: (files: Files) => files.deleteGroupFolder('123', 'folder-id'),
};
function fixture(returned: unknown) {
  const lifetime = new NativeServiceLifetime();
  let dispatches = 0;
  const result = () => {
    dispatches++;
    return returned;
  };
  const files = createGroupFiles({
    signal: lifetime.signal,
    awaitAlive: lifetime.awaitAlive,
    supportsFileCount: () => true,
    supportsFolderCreation: () => true,
    supportsFolderDeletion: () => true,
    getFileCountService: () => ({ batchGetGroupFileCount: result }),
    getFolderCreationService: () => ({ createGroupFolder: result }),
    getFolderDeletionService: () => ({ deleteGroupFolder: result }),
  });
  return { files, lifetime, dispatches: () => dispatches };
}
function response(action: keyof typeof actions, code: number) {
  if (action === 'count') return { result: code, groupCodes: ['123'], groupFileCounts: [7] };
  if (action === 'delete') return { result: code, groupFileCommonResult: { retCode: 0 } };
  return {
    result: code,
    resultWithGroupItem: {
      result: { retCode: 0 },
      groupItem: {
        peerId: '123',
        folderInfo: { folderId: 'folder-id', parentFolderId: '', folderName: 'folder' },
      },
    },
  };
}
for (const action of ['count', 'create', 'delete'] as const) {
  for (const mode of ['zero', 'nonzero', 'throw'] as const) {
    test(`${action} result descriptor retirement ${mode} stops interpretation and further reads`, async () => {
      let closed = false;
      const after: string[] = [];
      let retire = () => {};
      const returned = new Proxy(response(action, mode === 'nonzero' ? 7 : 0), {
        getOwnPropertyDescriptor(target, key) {
          if (closed) after.push(String(key));
          if (key === 'result') {
            closed = true;
            retire();
            if (mode === 'throw') throw new Error('opaque projection failure');
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      const f = fixture(returned);
      retire = () => f.files.close();
      try {
        await assert.rejects(actions[action](f.files), /closed/);
        assert.deepEqual(after, []);
        assert.equal(f.dispatches(), 1);
      } finally {
        f.files.close();
        f.lifetime.close();
      }
    });
  }
}
for (const selected of ['length', '0'] as const) {
  test(`count selected array ${selected} retirement prevents later descriptor reads`, async () => {
    let closed = false;
    let retire = () => {};
    const after: string[] = [];
    const groups = new Proxy(['123'], {
      getOwnPropertyDescriptor(target, key) {
        if (closed) after.push(`groups.${String(key)}`);
        if (key === selected) {
          closed = true;
          retire();
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const returned = new Proxy(
      { result: 0, groupCodes: groups, groupFileCounts: [7] },
      {
        getOwnPropertyDescriptor(target, key) {
          if (closed) after.push(`result.${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const f = fixture(returned);
    retire = () => f.files.close();
    try {
      await assert.rejects(f.files.getGroupFileCount('123'), /closed/);
      assert.deepEqual(after, []);
      assert.equal(f.dispatches(), 1);
    } finally {
      f.files.close();
      f.lifetime.close();
    }
  });
}

for (const action of ['create', 'delete'] as const) {
  for (const mode of ['zero', 'nonzero', 'throw'] as const) {
    test(`${action} inner status ${mode} retirement stops nested interpretation`, async () => {
      let closed = false;
      let retire = () => {};
      const after: string[] = [];
      const inner = new Proxy(
        { retCode: mode === 'nonzero' ? 7 : 0 },
        {
          getOwnPropertyDescriptor(target, key) {
            if (closed) after.push(`inner.${String(key)}`);
            if (key === 'retCode') {
              closed = true;
              retire();
              if (mode === 'throw') throw new Error('opaque inner failure');
            }
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        },
      );
      const details = new Proxy(
        { result: inner, groupItem: {} },
        {
          getOwnPropertyDescriptor(target, key) {
            if (closed) after.push(`details.${String(key)}`);
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        },
      );
      const returned = { result: 0, resultWithGroupItem: details, groupFileCommonResult: inner };
      const f = fixture(returned);
      retire = () => f.files.close();
      try {
        await assert.rejects(actions[action](f.files), /closed/);
        assert.deepEqual(after, []);
        assert.equal(f.dispatches(), 1);
      } finally {
        f.files.close();
        f.lifetime.close();
      }
    });
  }
}
for (const mode of ['value', 'throw'] as const) {
  test(`creation folderName ${mode} descriptor retirement cannot publish snapshot`, async () => {
    let retire = () => {};
    let reads = 0;
    const folder = new Proxy(
      { folderId: 'folder-id', parentFolderId: '', folderName: 'folder' },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === 'folderName') {
            reads++;
            retire();
            if (mode === 'throw') throw new Error('opaque name failure');
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const f = fixture({
      result: 0,
      resultWithGroupItem: {
        result: { retCode: 0 },
        groupItem: { peerId: '123', folderInfo: folder },
      },
    });
    retire = () => f.files.close();
    try {
      await assert.rejects(f.files.createGroupFolder('123', 'folder'), /closed/);
      assert.equal(reads, 1);
      assert.equal(f.dispatches(), 1);
    } finally {
      f.files.close();
      f.lifetime.close();
    }
  });
}
