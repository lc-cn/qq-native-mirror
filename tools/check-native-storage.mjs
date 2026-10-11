import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = dirname(directory);
const require = createRequire(new URL('../sdk/package.json', import.meta.url));
const sources = [
  'dedup-native-npm.mjs',
  'dedup-native-npm.test.mjs',
  'native-storage-plan.mjs',
  'native-storage-plan.test.mjs',
  'native-source-identity.mjs',
  'native-source-identity.test.mjs',
  'verify-dedup-consumer.mjs',
  'verify-dedup-consumer.test.mjs',
  'check-native-storage.mjs',
  'eslint.config.mjs',
  'tsconfig.consumer-ci.json',
  'consumer-ci-gates.test.mjs',
]
  .map((path) => 'tools/' + path)
  .concat([
    'ci/build-platform.mjs',
    'ci/aggregate-release.mjs',
    'ci/native-package-distribution.mjs',
    'ci/native-package-distribution.test.mjs',
    'ci/verify-consumer.mjs',
    'ci/current-source-mirror.mjs',
    'ci/consumer-resources.mjs',
    'ci/consumer-resources.test.mjs',
    'ci/npm.mjs',
    'version-ci/main-artifact.mjs',
    'version-ci/build-main-contract.mjs',
    'version-ci/main-artifact.test.mjs',
    'version-ci/build-main-contract.test.mjs',
  ]);

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
run([
  '--test',
  'tools/dedup-native-npm.test.mjs',
  'tools/native-storage-plan.test.mjs',
  'tools/native-source-identity.test.mjs',
  'tools/verify-dedup-consumer.test.mjs',
  'ci/native-package-distribution.test.mjs',
  'ci/consumer-resources.test.mjs',
  'tools/consumer-ci-gates.test.mjs',
  'version-ci/main-artifact.test.mjs',
  'version-ci/build-main-contract.test.mjs',
]);
