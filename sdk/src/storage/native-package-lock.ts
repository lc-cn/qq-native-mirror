import { runWithCleanup } from '../runtime/cleanup.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import {
  publishProcessLock,
  readProcessLock,
  removeOwnedProcessLock,
  processLockErrorCode,
} from './process-lock.ts';

// Bounded synchronous owner-file publication is shared with the account lock.
export async function acquirePackageLock(target: string): Promise<() => Promise<void>> {
  const lock = `${target}.lock`;
  const owner = `${process.pid}-${randomUUID()}`;
  const started = Date.now();
  for (;;) {
    try {
      publishProcessLock(lock, owner);
      return async () => {
        removeOwnedProcessLock(lock, owner);
      };
    } catch (error) {
      if (processLockErrorCode(error) !== 'EEXIST') throw error;
    }
    const existing = readProcessLock(lock);
    if (existing === undefined) continue;
    if (existing && !/^\d+-[a-zA-Z0-9-]+$/.test(existing))
      throw new Error(`Invalid native package lock owner: ${lock}`);
    const pid = Number(existing.split('-')[0]);
    let dead = false;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        dead = processLockErrorCode(error) === 'ESRCH';
      }
    }
    if (dead) {
      // A token-specific claim prevents two waiters from unlinking a replacement lock.
      const claim = `${lock}.reap-${existing}`;
      try {
        await mkdir(claim);
        await runWithCleanup(
          () => removeOwnedProcessLock(lock, existing),
          () => rm(claim, { recursive: true, force: true }),
        );
        continue;
      } catch (error) {
        const code = processLockErrorCode(error);
        if (code !== 'EEXIST' && code !== 'ENOENT') throw error;
      }
    }
    if (Date.now() - started > 180_000)
      throw new Error(`Timed out waiting for native package lock: ${lock}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
