import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(new URL('../sdk/package.json', import.meta.url));
const sources = [
  'dedup-native-npm.mjs',
  'dedup-native-npm.test.mjs',
  'native-storage-plan.mjs',
  'native-storage-plan.test.mjs',
  'check-native-storage.mjs',
  'eslint.config.mjs',
];

function run(arguments_) {
  execFileSync(process.execPath, arguments_, { cwd: directory, stdio: 'inherit' });
}

run([
  join(dirname(require.resolve('prettier/package.json')), 'bin/prettier.cjs'),
  '--config',
  '../sdk/.prettierrc.json',
  '--check',
  ...sources,
]);
run([
  join(dirname(require.resolve('eslint/package.json')), 'bin/eslint.js'),
  '--config',
  'eslint.config.mjs',
  '--max-warnings=0',
  ...sources,
]);
run(['--test', 'dedup-native-npm.test.mjs', 'native-storage-plan.test.mjs']);
