import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const repo = 'lc-cn/qq-native-mirror';
/** @param {unknown} value @param {string} message */
const requireThat = (value, message) => {
  if (!value) throw new Error(message);
};
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** @param {import('node:crypto').BinaryLike} bytes @param {string} [algorithm] @param {import('node:crypto').BinaryToTextEncoding} [encoding] */
export const digest = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);

/** @typedef {{name:string,version:string,tarball:string,size:number,sha256:string,integrity:string}} MainRow */
/** @typedef {{repository:string,commit:string,runId:string,runAttempt:number,main:MainRow,mode?:string,schemaVersion?:number,sdkVersion?:string,tag?:string,manifestSha256?:string}} MainSource */
/** @param {unknown} value @param {string} message @returns {Record<string,unknown>} */
function record(value, message) {
  requireThat(typeof value === 'object' && value !== null, message);
  return /** @type {Record<string,unknown>} */ (value);
}
/** @param {unknown} value @param {NodeJS.ProcessEnv} [environment] @returns {MainRow} */
export function validateMainSource(value, environment = process.env) {
  const source = record(value, 'Invalid main source identity');
  requireThat(
    source?.repository === repo &&
      typeof source.commit === 'string' &&
      /^[a-f0-9]{40}$/.test(source.commit) &&
      typeof source.runId === 'string' &&
      /^[1-9]\d*$/.test(source.runId) &&
      typeof source.runAttempt === 'number' &&
      Number.isInteger(source.runAttempt) &&
      source.runAttempt > 0,
    'Invalid main source identity',
  );
  const row = record(source.main, 'Invalid main package declaration');
  requireThat(
    row?.name === 'qq-native-client' &&
      typeof row.version === 'string' &&
      semver.test(row.version) &&
      row.tarball === `qq-native-client-${row.version}.tgz` &&
      typeof row.size === 'number' &&
      Number.isSafeInteger(row.size) &&
      row.size > 0 &&
      typeof row.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(row.sha256) &&
      typeof row.integrity === 'string' &&
      /^sha512-[A-Za-z0-9+/]{86}==$/.test(row.integrity),
    'Invalid main package declaration',
  );
  if (source.mode === 'current-source') {
    requireThat(
      source.schemaVersion === 2 &&
        source.sdkVersion === row.version &&
        source.commit === environment.GITHUB_SHA &&
        source.runId === environment.GITHUB_RUN_ID &&
        source.runAttempt === Number(environment.GITHUB_RUN_ATTEMPT),
      'Main belongs to a different source run',
    );
    requireThat(environment.SDK_SOURCE_MODE === 'current-source', 'Main source mode changed');
  } else {
    requireThat(
      environment.SDK_SOURCE_MODE === 'published-baseline' &&
        source.tag === 'npm-v0.0.1-ci-37890893656' &&
        source.commit === '9237a3a50329e5ce8d247c3f153003501cb7c349' &&
        source.runId === '37890893656' &&
        source.runAttempt === 1 &&
        row.version === '0.0.1' &&
        row.size === 236137 &&
        row.sha256 === '346bfee5895de2e0ef236cfb25d97654c8b773a5ec5adc67568b79e81301b11a' &&
        typeof source.manifestSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(source.manifestSha256),
      'Unknown published baseline',
    );
  }
  return /** @type {MainRow} */ (row);
}

export async function readMainArtifact(directory = 'out', environment = process.env) {
  const sourceBytes = await readFile(join(directory, 'main-source.json'));
  const sourceSha256 = digest(sourceBytes);
  if (environment.EXPECTED_MAIN_SOURCE_SHA256 !== undefined)
    requireThat(
      /^[a-f0-9]{64}$/.test(environment.EXPECTED_MAIN_SOURCE_SHA256) &&
        sourceSha256 === environment.EXPECTED_MAIN_SOURCE_SHA256,
      'Main source seal differs from shared producer',
    );
  const source = /** @type {unknown} */ (JSON.parse(sourceBytes.toString('utf8')));
  const row = validateMainSource(source, environment);
  const bytes = await readFile(join(directory, row.tarball));
  requireThat(
    bytes.length === row.size &&
      digest(bytes) === row.sha256 &&
      `sha512-${digest(bytes, 'sha512', 'base64')}` === row.integrity,
    'Main tarball bytes changed',
  );
  return {
    source: /** @type {MainSource} */ (source),
    row,
    path: join(directory, row.tarball),
    sourceSha256,
  };
}
