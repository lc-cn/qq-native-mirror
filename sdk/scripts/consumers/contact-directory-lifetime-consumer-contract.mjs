import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Exercise installed directory retirement without loading QQ or using an account.
 * @param {string} packageRoot
 */
export async function verifyContactDirectoryLifetimeConsumer(packageRoot) {
  const { createContactDirectory } =
    await /** @type {Promise<typeof import('../../src/features/contacts/contact-directory.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/features/contacts/contact-directory.js')).href)
    );
  const { NativeServiceLifetime } =
    await /** @type {Promise<typeof import('../../src/runtime/native-service-lifetime.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/runtime/native-service-lifetime.js')).href)
    );
  for (const stage of ['buddy', 'profile', 'uid']) {
    const account = new NativeServiceLifetime();
    let calls = 0;
    /** @type {(reason: unknown) => void} */
    let rejectLate = () => {};
    const late = new Promise((_, reject) => {
      rejectLate = reject;
    });
    const directory = createContactDirectory({
      signal: account.signal,
      version: '7.0.2-53644',
      awaitAlive: account.awaitAlive,
      getBuddyService: () => ({
        getBuddyListV2() {
          calls++;
          return stage === 'buddy' ? late : { result: 0, data: [{ buddyUids: ['u_fixture'] }] };
        },
      }),
      getProfileService: () => ({
        getCoreAndBaseInfo() {
          calls++;
          return late;
        },
      }),
      getUidService: () => ({
        getUid() {
          calls++;
          return late;
        },
      }),
    });
    const result = stage === 'uid' ? directory.uidFor('123') : directory.listFriends();
    let settled = false;
    const stopped = assert.rejects(result, { message: 'Contact directory is closed' }).then(() => {
      settled = true;
    });
    void stopped.catch(() => {});
    try {
      await new Promise((resolve) => setImmediate(resolve));
      directory.close();
      directory.close();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, true, 'Directory must retire before native completion');
      await stopped;
      assert.equal(calls, stage === 'profile' ? 2 : 1);
      assert.equal(await account.awaitAlive(Promise.resolve('sibling')), 'sibling');
      await assert.rejects(directory.uidFor('123'), /closed/);
      assert.throws(() => directory.rememberMembers([]), /closed/);
    } finally {
      rejectLate(new Error('Controlled late directory failure'));
      directory.close();
      account.close();
      await stopped;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    contactDirectoryLocalRetirementContract: true,
    contactDirectoryLateFailureObserved: true,
    contactDirectorySiblingPreserved: true,
    nativeContactDirectoryQueryAttempted: false,
    accountUsed: false,
  };
}
