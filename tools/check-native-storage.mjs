import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = dirname(directory);
const require = createRequire(new URL('../sdk/package.json', import.meta.url));
// Reviewed static tooling and offline tests only; production entries are never imported here.
const sources = [
  'tools/dedup-native-npm.mjs',
  'tools/dedup-native-npm.test.mjs',
  'tools/native-storage-plan.mjs',
  'tools/native-storage-plan.test.mjs',
  'tools/native-source-identity.mjs',
  'tools/native-source-identity.test.mjs',
  'tools/verify-dedup-consumer.mjs',
  'tools/verify-dedup-consumer.test.mjs',
  'tools/check-native-storage.mjs',
  'tools/eslint.config.mjs',
  'tools/tsconfig.consumer-ci.json',
  'tools/consumer-ci-gates.test.mjs',
  'ci/build-platform.mjs',
  'ci/aggregate-release.mjs',
  'ci/native-package-distribution.mjs',
  'ci/native-package-distribution.test.mjs',
  'ci/verify-consumer.mjs',
  'ci/current-source-mirror.mjs',
  'ci/consumer-resources.mjs',
  'ci/consumer-resources.test.mjs',
  'ci/consumer-acquisition.test.mjs',
  'ci/npm.mjs',
  'version-ci/main-artifact.mjs',
  'version-ci/acquire-main.mjs',
  'version-ci/build-main.mjs',
  'version-ci/driver-transaction.mjs',
  'version-ci/driver-transaction.test.mjs',
  'version-ci/build-main-contract.mjs',
  'version-ci/main-artifact.test.mjs',
  'version-ci/build-main-contract.test.mjs',
  'version-ci/consumer.mjs',
  'version-ci/verify.mjs',
  'version-ci/matrix.mjs',
  'version-ci/matrix.test.mjs',
  'version-ci/seal-main.mjs',
  'version-ci/mirror-selection.mjs',
  'version-ci/mirror-selection.test.mjs',
  'version-ci/offline-fixture.mjs',
  'ci/verified-download.mjs',
  'ci/verified-download.test.mjs',
  'ci/bundle-video-codec.mjs',
  'tools/native-storage-inventory.test.mjs',
];
const offlineTests = sources.filter((path) => path.endsWith('.test.mjs'));

function run(arguments_) {
  execFileSync(process.execPath, arguments_, { cwd: root, stdio: 'inherit' });
}

run([
  join(dirname(require.resolve('prettier/package.json')), 'bin/prettier.cjs'),
  '--config',
  'sdk/.prettierrc.json',
  '--check',
  ...sources,
]);
run([
  join(dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
  '--noEmit',
  '-p',
  'tools/tsconfig.consumer-ci.json',
]);
run([
  join(dirname(require.resolve('eslint/package.json')), 'bin/eslint.js'),
  '--config',
  'tools/eslint.config.mjs',
  '--max-warnings=0',
  ...sources.filter((path) => path.endsWith('.mjs')),
]);
run(['--test', ...offlineTests]);
