import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, readlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { lockDataDirectory } from '../src/storage/data-directory-lock.ts';
test('account directory lock excludes live owners and reclaims only a dead process token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-data-lock-'));
  try {
    const release = lockDataDirectory(root);
    await assert.rejects(async () => lockDataDirectory(root), /already in use/);
    release();
    release();
    const deadPid = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.pid))'],
      { encoding: 'utf8' },
    );
    await symlink(
      `${deadPid}-00000000-0000-0000-0000-000000000000`,
      join(root, '.qq-native-client.lock'),
    );
    const recovered = lockDataDirectory(root);
    assert.match(
      await readFile(join(root, '.qq-native-client.lock'), 'utf8'),
      new RegExp(`^${process.pid}-`),
    );
    recovered();
    await symlink('unexpected-owner', join(root, '.qq-native-client.lock'));
    await assert.rejects(async () => lockDataDirectory(root), /Invalid/);
    assert.equal(await readlink(join(root, '.qq-native-client.lock')), 'unexpected-owner');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
