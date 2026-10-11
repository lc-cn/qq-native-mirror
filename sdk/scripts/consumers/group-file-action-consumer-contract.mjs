import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Exercise the packed file owner without native loading or account use.
 * @param {string} packageRoot
 */
export async function verifyGroupFileActionLifetimeConsumer(packageRoot) {
  const { createGroupFiles } =
    await /** @type {Promise<typeof import('../../src/features/groups/group-files.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/features/groups/group-files.js')).href)
    );
  const { NativeServiceLifetime } =
    await /** @type {Promise<typeof import('../../src/runtime/native-service-lifetime.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/runtime/native-service-lifetime.js')).href)
    );
  const compatibility =
    await /** @type {Promise<typeof import('../../src/features/groups/group-file-operations.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/features/groups/group-file-operations.js')).href)
    );
  const countProtocol =
    await /** @type {Promise<typeof import('../../src/features/groups/group-file-count.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/features/groups/group-file-count.js')).href)
    );
  const folderProtocol =
    await /** @type {Promise<typeof import('../../src/features/groups/group-folder-operations.ts')>} */ (
      import(
        pathToFileURL(join(packageRoot, 'dist/features/groups/group-folder-operations.js')).href
      )
    );
  assert.equal(compatibility.getGroupFileCount, countProtocol.getGroupFileCount);
  assert.equal(compatibility.createGroupFolder, folderProtocol.createGroupFolder);
  assert.equal(compatibility.deleteGroupFolder, folderProtocol.deleteGroupFolder);

  const deletionLife = new NativeServiceLifetime();
  let fileDispatches = 0;
  /** @type {unknown} */
  let deletionReceipt = {
    result: 0,
    transGroupFileResult: {
      result: { retCode: 0 },
      successFileIdList: ['opaque/file'],
      failFileIdList: [],
    },
  };
  const deletion = createGroupFiles({
    signal: deletionLife.signal,
    awaitAlive: deletionLife.awaitAlive,
    supportsFileCount: () => false,
    supportsFolderCreation: () => false,
    supportsFolderDeletion: () => false,
    supportsFileDeletion: () => true,
    getFileCountService() {
      throw new Error('File deletion acquired count service');
    },
    getFolderCreationService() {
      throw new Error('File deletion acquired folder creation');
    },
    getFolderDeletionService() {
      throw new Error('File deletion acquired folder deletion');
    },
    getFileDeletionService() {
      return {
        deleteGroupFile(groupId, params, files) {
          assert.deepEqual([groupId, params, files], ['00123', [102], ['opaque/file']]);
          fileDispatches++;
          return deletionReceipt;
        },
      };
    },
  });
  try {
    await assert.rejects(deletion.deleteGroupFile('123', ''), /fileId/);
    assert.equal(fileDispatches, 0);
    await deletion.deleteGroupFile('00123', 'opaque/file');
    deletionReceipt = {
      result: 0,
      transGroupFileResult: {
        result: { retCode: 0 },
        successFileIdList: ['different-file'],
        failFileIdList: [],
      },
    };
    await assert.rejects(deletion.deleteGroupFile('00123', 'opaque/file'));
    assert.equal(fileDispatches, 2);
    deletion.close();
    await assert.rejects(deletion.deleteGroupFile('00123', 'opaque/file'), /closed/);
    assert.equal(fileDispatches, 2);
    assert.equal(await deletionLife.awaitAlive(Promise.resolve('sibling')), 'sibling');
  } finally {
    deletion.close();
    deletionLife.close();
  }

  // A descriptor trap can retire the local owner even though no accessor runs.
  // Use the actual account lifetime to distinguish local retirement from Session close.
  for (const stage of [
    'count-result',
    'count-length',
    'count-index',
    'create-result',
    'create-folder',
    'delete-result',
    'delete-status',
  ]) {
    const account = new NativeServiceLifetime();
    let retired = false;
    let laterReads = 0;
    let dispatches = 0;
    /** @template {object} T
     * @param {T} value
     * @param {string | undefined} stopKey
     * @returns {T}
     */
    function watched(value, stopKey) {
      return new Proxy(value, {
        getOwnPropertyDescriptor(target, key) {
          if (retired) laterReads++;
          if (key === stopKey) {
            retired = true;
            assert.ok(owner);
            owner.close();
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    }
    const countResponse = watched(
      {
        result: 0,
        groupCodes: watched(
          ['123'],
          stage === 'count-length' ? 'length' : stage === 'count-index' ? '0' : undefined,
        ),
        groupFileCounts: watched([1], undefined),
      },
      stage === 'count-result' ? 'result' : undefined,
    );
    const folder = watched(
      { folderId: 'folder-id', parentFolderId: '', folderName: 'folder' },
      stage === 'create-folder' ? 'folderId' : undefined,
    );
    const creationResponse = watched(
      {
        result: 0,
        resultWithGroupItem: watched(
          {
            result: watched({ retCode: 0 }, undefined),
            groupItem: watched({ peerId: '123', folderInfo: folder }, undefined),
          },
          undefined,
        ),
      },
      stage === 'create-result' ? 'result' : undefined,
    );
    const deletionResponse = watched(
      {
        result: 0,
        groupFileCommonResult: watched(
          { retCode: 7 },
          stage === 'delete-status' ? 'retCode' : undefined,
        ),
      },
      stage === 'delete-result' ? 'result' : undefined,
    );
    const owner = createGroupFiles({
      signal: account.signal,
      awaitAlive: account.awaitAlive,
      supportsFileCount: () => true,
      supportsFolderCreation: () => true,
      supportsFolderDeletion: () => true,
      getFileCountService: () => ({
        batchGetGroupFileCount() {
          dispatches++;
          return countResponse;
        },
      }),
      getFolderCreationService: () => ({
        createGroupFolder() {
          dispatches++;
          return creationResponse;
        },
      }),
      getFolderDeletionService: () => ({
        deleteGroupFolder() {
          dispatches++;
          return deletionResponse;
        },
      }),
    });
    try {
      const operation = stage.startsWith('count')
        ? owner.getGroupFileCount('123')
        : stage.startsWith('create')
          ? owner.createGroupFolder('123', 'folder')
          : owner.deleteGroupFolder('123', 'folder-id');
      await assert.rejects(operation, /closed/);
      assert.equal(retired, true, stage);
      assert.equal(laterReads, 0, stage);
      assert.equal(dispatches, 1, stage);
      assert.equal(account.signal.aborted, false, stage);
      assert.equal(await account.awaitAlive(Promise.resolve('sibling')), 'sibling');
    } finally {
      owner.close();
      account.close();
    }
  }
  const life = new NativeServiceLifetime();
  let calls = 0;
  /** @type {AbortSignal|undefined} */
  let localSignal;
  /** @type {(value: unknown) => void} */
  let rejectLate = () => {
    throw new Error('Native dispatch did not start');
  };
  const pending = new Promise((_, reject) => {
    rejectLate = reject;
  });
  const files = createGroupFiles({
    signal: life.signal,
    awaitAlive(value, signal) {
      localSignal = signal;
      return life.awaitAlive(value, signal);
    },
    supportsFileCount: () => true,
    supportsFolderCreation: () => true,
    supportsFolderDeletion: () => true,
    getFileCountService() {
      return {
        batchGetGroupFileCount() {
          calls++;
          return pending;
        },
      };
    },
    getFolderCreationService() {
      throw new Error('Closed owner acquired folder creation');
    },
    getFolderDeletionService() {
      throw new Error('Closed owner acquired folder deletion');
    },
  });
  try {
    const result = files.getGroupFileCount('123');
    const stopped = assert.rejects(result, /closed/);
    assert.equal(calls, 1);
    assert.ok(localSignal);
    files.close();
    files.close();
    assert.equal(localSignal.aborted, true);
    await stopped;
    rejectLate(new Error('Controlled late native failure'));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(files.getGroupFileCount('123'), /closed/);
    await assert.rejects(files.createGroupFolder('123', 'folder'), /closed/);
    await assert.rejects(files.deleteGroupFolder('123', 'folder-id'), /closed/);
    assert.equal(calls, 1);
    assert.equal(await life.awaitAlive(Promise.resolve('sibling')), 'sibling');
    return {
      groupFileProtocolCompatibilityIdentity: true,
      groupFileActionDescriptorRetirementContract: true,
      groupFileCountSelectedArrayRetirementContract: true,
      groupFileActionOwnerRetirementContract: true,
      groupFileActionLocalWaitSignalContract: true,
      groupFileActionLateFailureObserved: true,
      groupFileActionSiblingPreserved: true,
      groupFileDeletionExactReceiptContract: true,
      groupFileDeletionOwnerIsolationContract: true,
      nativeGroupFileActionAttempted: false,
      accountUsed: false,
    };
  } finally {
    files.close();
    life.close();
  }
}
