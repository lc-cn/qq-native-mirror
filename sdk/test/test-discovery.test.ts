import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const packageRoot = new URL('../', import.meta.url);
const metadata = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'));
const command: string = metadata.scripts.test;
const patterns = Array.from(command.matchAll(/"([^"]+)"/g), (match) => match[1]!);

test('test entry recursively runs TS and MJS once without acquiring helpers or executors', (t) => {
  assert.equal(command, 'node --test "test/**/*.test.ts" "test/**/*.test.mjs"');
  const directory = mkdtempSync(join(tmpdir(), 'qq-test-discovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  const names = ['root-ts', 'root-mjs', 'nested-ts', 'nested-mjs'];
  for (const [path, name] of [
    ['test/root.test.ts', names[0]],
    ['test/root.test.mjs', names[1]],
    ['test/features/contacts/nested.test.ts', names[2]],
    ['test/features/contacts/nested.test.mjs', names[3]],
  ]) {
    const file = join(directory, path!);
    mkdirSync(dirname(file), { recursive: true });
    const declaration = file.endsWith('.ts') ? 'const value: number = 1;' : 'const value = 1;';
    writeFileSync(
      file,
      `import test from 'node:test'; import assert from 'node:assert/strict';
       ${declaration} test('${name}', () => assert.equal(value, 1));`,
    );
  }
  for (const path of [
    'test/helpers/helper.ts',
    'test/fixtures/native-worker.mjs',
    'scripts/readonly-sdk-acceptance.ts',
  ]) {
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "throw new Error('Non-test file must not execute');");
  }
  // A nested runner must discover files rather than inherit the current test-child bootstrap mode.
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...patterns], {
    cwd: directory,
    env: environment,
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of names)
    assert.equal(
      result.stdout.match(new RegExp(`^ok \\d+ - ${name}$`, 'gm'))?.length,
      1,
      result.stdout,
    );
  assert.match(result.stdout, /^# tests 4$/m);
});

test('the recursive entry covers the test inventory without executing fixture directories', () => {
  const discovered = patterns.flatMap((pattern) => globSync(pattern, { cwd: packageRoot }));
  assert.equal(new Set(discovered).size, discovered.length, 'Each test file must run once');
  const inventory = globSync('test/**/*', { cwd: packageRoot }).filter((path) =>
    /\.test\.(?:ts|mjs)$/.test(path),
  );
  assert.deepEqual(discovered.toSorted(), inventory.toSorted());
  for (const path of inventory)
    assert.ok(!/^test[/\\](?:helpers|fixtures)[/\\]/.test(path), `${path} belongs to fixtures`);
});
