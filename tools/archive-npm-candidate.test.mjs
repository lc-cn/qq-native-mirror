import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveCandidate, validateSourceRun } from './archive-npm-candidate.mjs';
const sha = 'a'.repeat(40), runId = '123';
const good = { id: 123, repository: { full_name: 'lc-cn/qq-native-mirror' }, path: '.github/workflows/native-npm.yml', status: 'completed', conclusion: 'success', head_sha: sha, run_attempt: 1 };
test('source identity requires exact successful native workflow and safe inputs', () => {
  assert.equal(validateSourceRun(good, runId, sha), 1);
  for (const change of [{ conclusion: 'failure' }, { status: 'in_progress' }, { path: '.github/workflows/other.yml' }, { head_sha: 'b'.repeat(40) }, { run_attempt: 0 }, { id: 999 }, { repository: { full_name: 'other/repo' } }]) assert.throws(() => validateSourceRun({ ...good, ...change }, runId, sha));
  assert.throws(() => validateSourceRun(good, '123;echo unsafe', sha));
});
test('archive gates immutable schema 2 identity and rechecks source before fake upload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-archive-contract-'));
  try {
    const packages = [];
    for (let n = 0; n < 7; n++) { const path = join(root, `fixture-${n}.tgz`); await writeFile(path, 'FAKE'); packages.push({ path }); }
    const manifest = { schemaVersion: 2, repository: 'lc-cn/qq-native-mirror', runId, commit: sha, runAttempt: 1, version: '0.0.2' };
    const options = { runId, sha, directory: root, archiveRunId: '456' };
    const calls = []; let reads = 0;
    const deps = { readRun: async () => { reads++; return good; }, validate: async () => ({ manifest, packages }), command: async (binary, args) => { calls.push([binary, args]); return ''; } };
    const result = await archiveCandidate(options, deps);
    assert.equal(reads, 2); assert.equal(result.assets, 9);
    assert.deepEqual(calls.map(row => row[0]), ['tar', 'gh']);
    const upload = calls[1][1]; assert.ok(upload.includes('npm-v0.0.2-ci-123')); assert.ok(upload.includes('--latest=false')); assert.equal(upload.filter(value => value.endsWith('.tgz')).length, 7);
    for (const patch of [{ schemaVersion: 1 }, { runAttempt: 2 }, { runId: '999' }, { commit: 'b'.repeat(40) }]) {
      calls.length = 0;
      await assert.rejects(archiveCandidate(options, { ...deps, validate: async () => ({ manifest: { ...manifest, ...patch }, packages }) }), /Artifact manifest/);
      assert.equal(calls.length, 0);
    }
    let stage = 0; calls.length = 0;
    await assert.rejects(archiveCandidate(options, { ...deps, readRun: async () => ++stage === 1 ? good : { ...good, run_attempt: 2 } }), /changed/);
    assert.equal(calls.length, 0);
    calls.length = 0;
    await assert.rejects(archiveCandidate(options, { ...deps, validate: async () => { throw Error('Digest mismatch'); } }), /Digest mismatch/);
    assert.equal(calls.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
