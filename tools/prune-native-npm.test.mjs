import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { validateProfile, stagePrunedPackage, validateConsumerReceipts } from './prune-native-npm.mjs';
const profile = JSON.parse(await readFile(new URL('./profiles/darwin-arm64-resources-v1.json', import.meta.url)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = () => structuredClone(profile);

test('only the reviewed device, vendor and source can select the pruning profile', () => {
  assert.equal(validateProfile(copy()).files.length, 47);
  for (const change of [p => p.platform = 'linux', p => p.arch = 'x64', p => p.sdkVersion = '0.0.3', p => p.source.runId = '1', p => p.source.commit = 'a'.repeat(40), p => p.version.qua = 'wrong']) {
    const value = copy(); change(value); assert.throws(() => validateProfile(value));
  }
});

test('pruning inventory rejects missing entry points, duplicates and unsafe paths', () => {
  for (const change of [p => p.files.pop(), p => p.files[1] = p.files[0], p => p.files[0].path = '../wrapper.node', p => p.files[0].path = '/wrapper.node', p => p.files[0].path = 'a\\b', p => p.files.find(r => r.path === 'wrapper.node').path = 'other.node', p => p.files[0].sha256 = 'wrong', p => p.files[0].size = -1]) {
    const value = copy(); change(value); assert.throws(() => validateProfile(value));
  }
});

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'qq-pruning-contract-'));
  try {
    const source = join(root, 'source'); await mkdir(source);
    const value = copy();
    const contents = new Map();
    value.files = value.files.map((row, index) => {
      const bytes = Buffer.from(`synthetic vendor bytes ${index}`); contents.set(row.path, bytes);
      return { path: row.path, sha256: sha(bytes), size: bytes.length };
    });
    const manifest = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', wrapper: 'wrapper.node', version: value.version, files: [...value.files, ...Array.from({length: 1110}, (_, index) => ({path: `removed/${index}.strings`, sha256: 'a'.repeat(64)}))] };
    const bytes = Buffer.from(JSON.stringify(manifest)); value.source.nativeManifestSha256 = sha(bytes);
    await writeFile(join(source, 'manifest.json'), bytes);
    await writeFile(join(source, 'package.json'), JSON.stringify({name: 'qq-native-client-darwin-arm64', version: '0.0.2', os: ['darwin'], cpu: ['arm64']}));
    for (const [path, data] of contents) { await mkdir(join(source, path, '..'), {recursive:true}); await writeFile(join(source, path), data); }
    await run({root, source, destination:join(root, 'candidate'), profile:value, contents});
  } finally { await rm(root, {recursive:true, force:true}); }
}

test('staging preserves every allowed vendor byte and retains only the exact 47 paths plus metadata', async () => fixture(async ({source, destination, profile, contents}) => {
  const before = await readFile(join(source, 'manifest.json'));
  const receipt = await stagePrunedPackage(profile, source, destination);
  const manifest = JSON.parse(await readFile(join(destination, 'manifest.json')));
  assert.equal(receipt.nativePaths, 47); assert.equal(manifest.profile, profile.id);
  assert.deepEqual(manifest.files.map(r => r.path), profile.files.map(r => r.path));
  for (const row of manifest.files) { assert.equal(row.url, row.path); assert.deepEqual(await readFile(join(destination, row.path)), contents.get(row.path)); }
  assert.deepEqual(await readFile(join(source, 'manifest.json')), before);
  const files=[];
  async function inventory(path='') { for (const row of await readdir(join(destination,path), {withFileTypes:true})) { const relative=path?`${path}/${row.name}`:row.name; if(row.isDirectory())await inventory(relative);else files.push(relative); } }
  await inventory(); assert.deepEqual(files.sort(), [...contents.keys(),'manifest.json','package.json','README.md'].sort());
}));

test('a changed retained native file fails before creating the candidate', async () => fixture(async ({source, destination, profile}) => {
  await writeFile(join(source, 'registration-bridge.node'), 'tampered');
  await assert.rejects(stagePrunedPackage(profile, source, destination), /bytes changed/);
  await assert.rejects(readdir(destination), {code:'ENOENT'});
}));

test('a changed source manifest fails before creating the candidate', async () => fixture(async ({source, destination, profile}) => {
  await writeFile(join(source, 'manifest.json'), '{}');
  await assert.rejects(stagePrunedPackage(profile, source, destination), /manifest changed/);
  await assert.rejects(readdir(destination), {code:'ENOENT'});
}));

test('an existing destination is preserved rather than overwritten', async () => fixture(async ({source, destination, profile}) => {
  await mkdir(destination); await writeFile(join(destination,'fallback'),'preserve');
  await assert.rejects(stagePrunedPackage(profile, source, destination), {code:'EEXIST'});
  assert.deepEqual(await readdir(destination), ['fallback']);
  assert.equal(await readFile(join(destination,'fallback'),'utf8'),'preserve');
}));

test('consumer binding refuses a stale builder, changed scope or unsuccessful installation', () => {
  const environment = {GITHUB_SHA:'a'.repeat(40), GITHUB_RUN_ID:'123'};
  const build = {schemaVersion:1, experimental:true, profile:profile.id, source:profile.source, nativePaths:47, packagedPaths:50, builderCommit:environment.GITHUB_SHA, builderRunId:environment.GITHUB_RUN_ID, accountAcceptanceEstablished:false, signingAuthenticityEstablished:false, published:false, defaultsChanged:false};
  const receipt = {platform:'darwin', arch:'arm64', exports:104, installedMainOnly:true, automaticPlatformSelection:true, prepared:true, closed:true, loginAttempted:false, nativeHistoryQueryAttempted:false, nativeFriendListQueryAttempted:false, nativeGroupListQueryAttempted:false, nativeGroupMemberQueryAttempted:false, tarballRequests:['qq-native-client','silk-wasm','qq-native-client-darwin-arm64']};
  validateConsumerReceipts(profile, build, receipt, environment);
  for (const change of [r => r.builderRunId = '122', r => r.builderCommit = 'b'.repeat(40), r => r.nativePaths = 46, r => r.source.runId = '1', r => r.published = true, r => r.accountAcceptanceEstablished = true]) {
    const value = structuredClone(build); change(value); assert.throws(() => validateConsumerReceipts(profile, value, receipt, environment));
  }
  for (const change of [r => r.platform = 'linux', r => r.prepared = false, r => r.closed = false, r => r.loginAttempted = true, r => r.nativeGroupMemberQueryAttempted = true, r => r.tarballRequests.push('qq-native-client-linux-x64'), r => r.tarballRequests.pop()]) {
    const value = structuredClone(receipt); change(value); assert.throws(() => validateConsumerReceipts(profile, build, value, environment));
  }
});
