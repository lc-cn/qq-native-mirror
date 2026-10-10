import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { npm } from '../ci/npm.mjs';
import { digest, validateMainSource, readMainArtifact } from './main-artifact.mjs';
import {
  validateCurrentBuildIdentity,
  validatePackedMainInventory,
} from './build-main-contract.mjs';

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
validateCurrentBuildIdentity({
  platform: process.platform,
  arch: process.arch,
  sourceCommit,
  environment: process.env,
});
const sdk = JSON.parse(await readFile('sdk/package.json'));
const devices = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
];
if (
  sdk.name !== 'qq-native-client' ||
  devices.some((device) => sdk.optionalDependencies?.[`qq-native-client-${device}`] !== sdk.version)
)
  throw Error('SDK native pins do not match main');
await mkdir('out', { recursive: true });
// Windows loads its verified internal-ABI adapter from the native mirror. The
// Unix registration bridge is compiled into the host main package as usual.
if (process.platform === 'win32') {
  execFileSync(npm[0], [...npm[1], 'run', 'clean'], { cwd: resolve('sdk'), stdio: 'inherit' });
  execFileSync(npm[0], [...npm[1], 'exec', 'tsc'], { cwd: resolve('sdk'), stdio: 'inherit' });
} else execFileSync(npm[0], [...npm[1], 'run', 'build'], { cwd: resolve('sdk'), stdio: 'inherit' });
const packed = JSON.parse(
  execFileSync(
    npm[0],
    [...npm[1], 'pack', '--ignore-scripts', '--json', '--pack-destination', resolve('out')],
    { cwd: resolve('sdk'), encoding: 'utf8' },
  ),
)[0];
validatePackedMainInventory(packed, sdk, process.platform, process.arch);
const bytes = await readFile('out/' + packed.filename);
if (
  packed.size !== bytes.length ||
  packed.integrity !== `sha512-${digest(bytes, 'sha512', 'base64')}`
)
  throw Error('npm pack integrity changed');
const source = {
  schemaVersion: 2,
  mode: 'current-source',
  repository: process.env.GITHUB_REPOSITORY,
  commit: sourceCommit,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  sdkVersion: sdk.version,
  main: {
    name: packed.name,
    version: packed.version,
    tarball: packed.filename,
    size: bytes.length,
    sha256: digest(bytes),
    integrity: packed.integrity,
  },
};
validateMainSource(source);
await writeFile('out/main-source.json', JSON.stringify(source, null, 2) + '\n');
await readMainArtifact();
console.log(JSON.stringify(source));
