import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectNativeSourceIdentity } from './native-source-identity.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture(version = '0.0.2') {
  return {
    schemaVersion: 2,
    repository: 'lc-cn/qq-native-mirror',
    commit: '85ef15aede7457b8c9f8410557c023e61ad108a8',
    runId: '38133938435',
    runAttempt: 1,
    version,
    packages: [
      'qq-native-client',
      ...['linux', 'darwin', 'win32'].flatMap((platform) =>
        ['x64', 'arm64'].map((arch) => `qq-native-client-${platform}-${arch}`),
      ),
    ].map((name) => ({ name, version })),
    extraMetadata: { labels: ['original'] },
  };
}
const encode = (value) => Buffer.from(JSON.stringify(value));
test('source identity accepts independently pinned current and future release identities', () => {
  for (const version of ['0.0.2', '1.2.3-next.1']) {
    const original = fixture(version),
      bytes = encode(original);
    assert.deepEqual(inspectNativeSourceIdentity(bytes, sha(bytes)), original);
  }
});
test('expected digest is an independent trust root, not a self-declared identity', () => {
  const original = encode(fixture()),
    pin = sha(original);
  for (const mutate of [
    (value) => (value.commit = 'a'.repeat(40)),
    (value) => (value.runId = '999'),
    (value) => {
      value.sha256 = pin;
      value.repository = 'attacker/mirror';
    },
  ]) {
    const changed = fixture();
    mutate(changed);
    assert.throws(() => inspectNativeSourceIdentity(encode(changed), pin));
  }
  for (const pinValue of ['a'.repeat(64), sha(original).toUpperCase(), '', 'g'.repeat(64)])
    assert.throws(() => inspectNativeSourceIdentity(original, pinValue));
});
test('trusted bytes still require complete release identity and package closure', () => {
  for (const mutate of [
    (value) => (value.schemaVersion = 1),
    (value) => (value.repository = 'other/mirror'),
    (value) => (value.commit = 'a'.repeat(39)),
    (value) => (value.commit = 'G'.repeat(40)),
    (value) => (value.runId = '1x'),
    (value) => (value.runId = 123),
    (value) => (value.runAttempt = 0),
    (value) => (value.runAttempt = 1.5),
    (value) => (value.runAttempt = Number.MAX_SAFE_INTEGER + 1),
    (value) => (value.version = '../1.2.3'),
    (value) => (value.version = '1.2.3\n'),
    (value) => value.packages.pop(),
    (value) => value.packages.push({ ...value.packages[0] }),
    (value) => (value.packages[1].name = value.packages[0].name),
    (value) => (value.packages[1].name = 'qq-native-client-unreviewed'),
    (value) => (value.packages[1].version = '0.0.3'),
  ]) {
    const value = fixture();
    mutate(value);
    const bytes = encode(value);
    assert.throws(() => inspectNativeSourceIdentity(bytes, sha(bytes)));
  }
  const bytes = Buffer.from('{bad json');
  assert.throws(() => inspectNativeSourceIdentity(bytes, sha(bytes)));
});
test('parsed identity owns nested metadata independently of caller bytes', () => {
  const original = fixture(),
    bytes = encode(original);
  const result = inspectNativeSourceIdentity(bytes, sha(bytes));
  bytes.fill(0);
  assert.deepEqual(result, original);
  result.packages[0].name = 'changed';
  result.extraMetadata.labels[0] = 'changed';
  assert.equal(original.packages[0].name, 'qq-native-client');
  assert.deepEqual(original.extraMetadata.labels, ['original']);
});
