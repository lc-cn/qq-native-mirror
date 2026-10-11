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
      groupFileActionOwnerRetirementContract: true,
      groupFileActionLocalWaitSignalContract: true,
      groupFileActionLateFailureObserved: true,
      groupFileActionSiblingPreserved: true,
      nativeGroupFileActionAttempted: false,
      accountUsed: false,
    };
  } finally {
    files.close();
    life.close();
  }
}
