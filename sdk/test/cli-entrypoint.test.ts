import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
const cli = await realpath(fileURLToPath(new URL('../src/cli.ts', import.meta.url)));
function invoke(entry: string, args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 5000 });
}
function help(entry: string) {
  const result = invoke(entry, ['--help']);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /qq-native-client <command>/);
  assert.match(result.stdout, /forward-resource/);
  assert.equal(result.stderr, '');
}
function missingResource(entry: string) {
  const result = invoke(entry, ['forward-resource']);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--resource-id is required/);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /wrapper|dlopen|catalog|ENOENT/);
}
test('actual source CLI canonical entry runs help and preflight errors without config/native', () => {
  help(cli);
  missingResource(cli);
});
test(
  'actual source CLI through a POSIX npm-bin-style symlink executes the same commands',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-entry-link-'));
    try {
      const alias = join(root, 'qq-native-client');
      await symlink(cli, alias, 'file');
      help(alias);
      missingResource(alias);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
test('importing CLI from another actual entry does not execute main even with help argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cli-import-entry-'));
  try {
    const entry = join(root, 'other-entry.mjs');
    await writeFile(
      entry,
      `await import(${JSON.stringify(pathToFileURL(cli).href)});console.log('import-only');\n`,
    );
    const result = invoke(entry, ['--help']);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'import-only\n');
    assert.equal(result.stderr, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('non-file argv during import is caught and cannot invoke CLI main', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cli-import-nonfile-'));
  try {
    const entry = join(root, 'nonfile-entry.mjs');
    await writeFile(
      entry,
      `process.argv[1]='file:///not-a-local-cli-entry';await import(${JSON.stringify(pathToFileURL(cli).href)});console.log('nonfile-import-only');\n`,
    );
    const result = invoke(entry, ['--help']);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'nonfile-import-only\n');
    assert.equal(result.stderr, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
