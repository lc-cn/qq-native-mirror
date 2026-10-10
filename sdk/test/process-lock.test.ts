import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  readlinkSync,
  readFileSync,
  unlinkSync,
  readdirSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  publishProcessLock,
  readProcessLock,
  removeOwnedProcessLock,
} from '../src/storage/process-lock.ts';
import { lockDataDirectory } from '../src/storage/data-directory-lock.ts';
const token = `${process.pid}-00000000-0000-0000-0000-000000000000`;
function fixture(fn: (dir: string, path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-process-lock-'));
  try {
    fn(dir, join(dir, '.qq-native-client.lock'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test('publication is a complete regular file and cleans losing temporary owners', () =>
  fixture((dir, path) => {
    publishProcessLock(path, token);
    assert.equal(lstatSync(path).isFile(), true);
    assert.equal(readProcessLock(path), token);
    assert.throws(() => publishProcessLock(path, token), { code: 'EEXIST' });
    assert.deepEqual(readdirSync(dir), ['.qq-native-client.lock']);
    removeOwnedProcessLock(path, token);
    removeOwnedProcessLock(path, token);
  }));
test('malformed, oversized, directory and outside-link owners remain untouched', () =>
  fixture((dir, path) => {
    for (const content of ['bad-owner', '1-' + 'x'.repeat(200), '0-token']) {
      writeFileSync(path, content);
      assert.throws(() => lockDataDirectory(dir), /Invalid/);
      assert.equal(readFileSync(path, 'utf8'), content);
      unlinkSync(path);
    }
    mkdirSync(path);
    assert.throws(() => lockDataDirectory(dir), /Invalid/);
    assert.equal(lstatSync(path).isDirectory(), true);
    rmSync(path, { recursive: true });
    const outside = join(dir, 'outside');
    writeFileSync(outside, token);
    symlinkSync(outside, path);
    assert.throws(() => lockDataDirectory(dir), /Invalid/);
    assert.equal(readlinkSync(path), outside);
    assert.equal(readFileSync(outside, 'utf8'), token);
  }));
test('release never removes a replacement token', () =>
  fixture((dir, path) => {
    const release = lockDataDirectory(dir);
    unlinkSync(path);
    const replacement = `${process.pid}-11111111-1111-1111-1111-111111111111`;
    publishProcessLock(path, replacement);
    release();
    assert.equal(readProcessLock(path), replacement);
  }));
test('dead regular-file owners are reclaimed', () =>
  fixture((dir, path) => {
    const dead = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.pid))'],
      { encoding: 'utf8' },
    );
    publishProcessLock(path, `${dead}-00000000-0000-0000-0000-000000000000`);
    const release = lockDataDirectory(dir);
    assert.match(readProcessLock(path)!, new RegExp(`^${process.pid}-`));
    release();
  }));
test('symlink creation denied does not prevent new account locks', () =>
  fixture((dir) => {
    const script = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';fs.symlinkSync=()=>{throw Object.assign(new Error('denied'),{code:'EPERM'})};syncBuiltinESMExports();const {lockDataDirectory}=await import(${JSON.stringify(resolve('src/storage/data-directory-lock.ts'))});const release=lockDataDirectory(${JSON.stringify(dir)});release();`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script]);
    assert.deepEqual(readdirSync(dir), []);
  }));
test('real child processes permit one concurrent owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-concurrent-lock-'));
  try {
    const script = `import {lockDataDirectory} from ${JSON.stringify(resolve('src/storage/data-directory-lock.ts'))};let release;try{release=lockDataDirectory(process.argv[1]);process.stdout.write('owner');await new Promise(r=>setTimeout(r,1500));release();}catch(e){if(!/already in use|recovery/.test(e.message))throw e;process.stdout.write('busy');}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dir]),
      ),
    );
    assert.equal(results.filter((r) => r.stdout === 'owner').length, 1);
    assert.equal(results.filter((r) => r.stdout === 'busy').length, 5);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
