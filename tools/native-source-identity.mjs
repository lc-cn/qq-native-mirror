import { createHash } from 'node:crypto';

const platforms = ['linux', 'darwin', 'win32'];
const architectures = ['x64', 'arm64'];
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const version = (value) =>
  typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

/** Bind a complete source cohort to an independently supplied digest before IO.
 * Archive, consumer receipt and permanent codec-material validation belongs to
 * validateRelease; this shared boundary cannot make self-declared hashes trusted.
 */
export function inspectNativeSourceIdentity(bytes, expectedSha256) {
  requireCondition(digest(expectedSha256), 'Independent source release SHA-256 required');
  requireCondition(
    Buffer.isBuffer(bytes) && createHash('sha256').update(bytes).digest('hex') === expectedSha256,
    'Source release bytes differ from independent SHA-256',
  );
  const release = JSON.parse(bytes);
  requireCondition(
    release?.schemaVersion === 2 &&
      release.repository === 'lc-cn/qq-native-mirror' &&
      typeof release.commit === 'string' &&
      /^[a-f0-9]{40}$/.test(release.commit) &&
      typeof release.runId === 'string' &&
      /^\d+$/.test(release.runId) &&
      Number.isSafeInteger(release.runAttempt) &&
      release.runAttempt > 0 &&
      version(release.version),
    'Source complete release identity mismatch',
  );
  const names = new Set(['qq-native-client']);
  for (const platform of platforms)
    for (const arch of architectures) names.add(`qq-native-client-${platform}-${arch}`);
  requireCondition(
    Array.isArray(release.packages) &&
      release.packages.length === names.size &&
      release.packages.every(
        (row) => row && row.version === release.version && names.delete(row.name),
      ) &&
      names.size === 0,
    'Source requires seven matching package identities',
  );
  // JSON parsing owns nested metadata even if the caller mutates its input buffer.
  return release;
}
