import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGroupFiles,
  type GroupFilesContext,
} from '../../../src/features/groups/files/group-files.ts';
import { NativeServiceLifetime } from '../../../src/runtime/native-service-lifetime.ts';

type Files = ReturnType<typeof createGroupFiles>;
const actions = {
  count: (files: Files) => files.getGroupFileCount('00123'),
  create: (files: Files) => files.createGroupFolder('00123', 'folder'),
  delete: (files: Files) => files.deleteGroupFolder('00123', 'folder-id'),
  deleteFile: (files: Files) => files.deleteGroupFile('00123', 'file-id'),
};
const responses = {
  count: { result: 0, groupCodes: ['123'], groupFileCounts: [0] },
  create: {
    result: 0,
    resultWithGroupItem: {
      result: { retCode: 0 },
      groupItem: {
        peerId: '123',
        folderInfo: { folderId: 'folder-id', parentFolderId: '', folderName: 'folder' },
      },
    },
  },
  delete: { result: 0, groupFileCommonResult: { retCode: 0 } },
  deleteFile: {
    result: 0,
    transGroupFileResult: {
      result: { retCode: 0 },
      successFileIdList: ['file-id'],
      failFileIdList: [],
    },
  },
};
const argumentsByAction = {
  count: [['00123']],
  create: ['00123', 'folder'],
  delete: ['00123', 'folder-id'],
  deleteFile: ['00123', [102], ['file-id']],
};
function fixture(action: keyof typeof actions, returned: unknown = responses[action]) {
  const life = new NativeServiceLifetime();
  let acquisitions = 0,
    calls = 0;
  let onSupport = () => {},
    onAcquire = () => {},
    onMethod = () => {};
  const support = function (this: GroupFilesContext) {
    assert.equal(this, context);
    onSupport();
    return true;
  };
  const acquire = () => {
    acquisitions++;
    onAcquire();
  };
  const invoke = (receiver: object) =>
    function (this: object, ...args: unknown[]) {
      assert.equal(this, receiver);
      assert.deepEqual(args, argumentsByAction[action]);
      calls++;
      return returned;
    };
  const context: GroupFilesContext = {
    signal: life.signal,
    awaitAlive: life.awaitAlive,
    supportsFileCount: support,
    supportsFolderCreation: support,
    supportsFolderDeletion: support,
    supportsFileDeletion: support,
    getFileDeletionService() {
      acquire();
      const service = {
        get deleteGroupFile() {
          onMethod();
          return invoke(service);
        },
      };
      return service;
    },
    getFileCountService() {
      acquire();
      const service = {
        get batchGetGroupFileCount() {
          onMethod();
          return invoke(service);
        },
      };
      return service;
    },
    getFolderCreationService() {
      acquire();
      const service = {
        get createGroupFolder() {
          onMethod();
          return invoke(service);
        },
      };
      return service;
    },
    getFolderDeletionService() {
      acquire();
      const service = {
        get deleteGroupFolder() {
          onMethod();
          return invoke(service);
        },
      };
      return service;
    },
  };
  const files = createGroupFiles(context);
  return {
    files,
    life,
    run: () => actions[action](files),
    counts: () => ({ acquisitions, calls }),
    closeDuring(stage: 'support' | 'acquire' | 'method') {
      if (stage === 'support') onSupport = () => files.close();
      if (stage === 'acquire') onAcquire = () => files.close();
      if (stage === 'method') onMethod = () => files.close();
    },
  };
}
for (const action of Object.keys(actions) as (keyof typeof actions)[]) {
  test(`${action} is retired when its file owner closes before invocation`, async () => {
    const f = fixture(action);
    f.files.close();
    f.files.close();
    await assert.rejects(f.run(), /closed/);
    assert.deepEqual(f.counts(), { acquisitions: 0, calls: 0 });
    assert.equal(await f.life.awaitAlive(Promise.resolve('sibling')), 'sibling');
    f.life.close();
  });
  for (const stage of ['support', 'acquire', 'method'] as const)
    test(`${action} cannot dispatch after reentrant close during ${stage}`, async () => {
      const f = fixture(action);
      f.closeDuring(stage);
      await assert.rejects(f.run(), /closed/);
      assert.equal(f.counts().calls, 0);
      assert.equal(f.counts().acquisitions, stage === 'support' ? 0 : 1);
      f.life.close();
    });
  for (const late of ['resolve', 'reject'] as const)
    test(`${action} pending completion retires on module close and observes late ${late}`, async () => {
      let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
      const pending = new Promise<unknown>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const f = fixture(action, pending),
        result = f.run(),
        stopped = assert.rejects(result, /closed/);
      assert.equal(f.counts().calls, 1);
      f.files.close();
      await stopped;
      if (late === 'resolve') resolve(responses[action]);
      else reject(new Error('Late native completion'));
      await new Promise<void>((done) => setImmediate(done));
      assert.equal(f.counts().calls, 1);
      await assert.rejects(f.run(), /closed/);
      assert.equal(await f.life.awaitAlive(Promise.resolve('sibling')), 'sibling');
      f.life.close();
    });
}
