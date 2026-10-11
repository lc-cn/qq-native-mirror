// Keep one entry for the standalone gate and the full test runner.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { extractSourceDependencies } from './helpers/source-dependencies.ts';
import './architecture/dependency-direction.ts';
import './architecture/module-ownership.ts';
import './architecture/composition.ts';
import './architecture/contracts.ts';
import './architecture/resources.ts';

test('architecture runner registers every focused suite', () => {
  const extracted = extractSourceDependencies(
    'test/architecture.test.ts',
    readFileSync(new URL(import.meta.url), 'utf8'),
  );
  assert.deepEqual(extracted.violations, []);
  const registered = extracted.dependencies
    .filter(({ specifier }) => specifier.startsWith('./architecture/'))
    .map(({ specifier }) => specifier)
    .sort();
  const available = readdirSync(new URL('./architecture/', import.meta.url), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `./architecture/${entry.name}`)
    .sort();
  assert.deepEqual(registered, available, 'Wire new suites into the architecture runner');
});
