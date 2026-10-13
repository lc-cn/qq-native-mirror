import { runWithCleanupSync } from '../runtime/cleanup.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  publishProcessLock,
  readProcessLock,
  removeOwnedProcessLock,
  processLockErrorCode,
} from './process-lock.ts';

/** Process-owned lock; abrupt exit leaves a token that a later worker can reclaim. */
export function lockDataDirectory(directory: string): () => void {
  const path = join(directory, '.qq-native-client.lock');
  const token = `${process.pid}-${randomUUID()}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      publishProcessLock(path, token);
      return () => removeOwnedProcessLock(path, token);
    } catch (error) {
      if (processLockErrorCode(error) !== 'EEXIST') throw error;
    }
    let owner: string | undefined;
    try {
      owner = readProcessLock(path);
    } catch (error) {
      throw new Error('Invalid account directory lock', { cause: error });
    }
    if (owner === undefined) continue;
    if (!/^\d+-[a-f0-9-]{36}$/.test(owner)) throw new Error('Invalid account directory lock owner');
    const pid = Number(owner.split('-')[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Invalid account directory lock PID');
    let dead = false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      dead = processLockErrorCode(error) === 'ESRCH';
    }
    if (!dead) throw new Error('Account data directory is already in use by a live worker');
    const claim = `${path}.reap-${owner}`;
    try {
      mkdirSync(claim);
    } catch (error) {
      if (processLockErrorCode(error) === 'EEXIST')
        throw new Error('Account directory lock recovery is already in progress', { cause: error });
      throw error;
    }
    runWithCleanupSync(
      () => removeOwnedProcessLock(path, owner),
      () => rmdirSync(claim),
    );
  }
  throw new Error('Account data directory lock changed concurrently');
}
