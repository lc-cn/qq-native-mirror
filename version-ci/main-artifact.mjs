import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const repo = 'lc-cn/qq-native-mirror';
const requireThat = (value, message) => { if (!value) throw new Error(message); };
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);

export function validateMainSource(source, environment = process.env) {
  requireThat(source?.repository === repo && /^[a-f0-9]{40}$/.test(source.commit ?? '') && typeof source.runId === 'string' && /^[1-9]\d*$/.test(source.runId) && Number.isInteger(source.runAttempt) && source.runAttempt > 0, 'Invalid main source identity');
  const row = source.main;
  requireThat(row?.name === 'qq-native-client' && typeof row.version === 'string' && semver.test(row.version) && row.tarball === `qq-native-client-${row.version}.tgz` && Number.isSafeInteger(row.size) && row.size > 0 && /^[a-f0-9]{64}$/.test(row.sha256 ?? '') && /^sha512-[A-Za-z0-9+/]{86}==$/.test(row.integrity ?? ''), 'Invalid main package declaration');
  if (source.mode === 'current-source') {
    requireThat(source.schemaVersion === 2 && source.sdkVersion === row.version && source.commit === environment.GITHUB_SHA && source.runId === environment.GITHUB_RUN_ID && source.runAttempt === Number(environment.GITHUB_RUN_ATTEMPT), 'Main belongs to a different source run');
    requireThat(environment.SDK_SOURCE_MODE === 'current-source', 'Main source mode changed');
  } else {
    requireThat(environment.SDK_SOURCE_MODE === 'published-baseline' && source.tag === 'npm-v0.0.1-ci-37890893656' && source.commit === '9237a3a50329e5ce8d247c3f153003501cb7c349' && source.runId === '37890893656' && source.runAttempt === 1 && row.version === '0.0.1' && row.size === 236137 && row.sha256 === '346bfee5895de2e0ef236cfb25d97654c8b773a5ec5adc67568b79e81301b11a' && /^[a-f0-9]{64}$/.test(source.manifestSha256 ?? ''), 'Unknown published baseline');
  }
  return row;
}

export async function readMainArtifact(directory = 'out', environment = process.env) {
  const source = JSON.parse(await readFile(join(directory, 'main-source.json')));
  const row = validateMainSource(source, environment);
  const bytes = await readFile(join(directory, row.tarball));
  requireThat(bytes.length === row.size && digest(bytes) === row.sha256 && `sha512-${digest(bytes, 'sha512', 'base64')}` === row.integrity, 'Main tarball bytes changed');
  return { source, row, path: join(directory, row.tarball) };
}
