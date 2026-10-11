import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'test/fixtures/client-lifecycle-event-types.ts');
const original = readFileSync(fixture, 'utf8');
function diagnostics(source: string) {
  const config = ts.readConfigFile(join(root, 'tsconfig.test.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.deepEqual(parsed.errors, []);
  const host = ts.createCompilerHost(parsed.options);
  const read = host.readFile.bind(host);
  host.readFile = (path) => (resolve(path) === fixture ? source : read(path));
  return ts.getPreEmitDiagnostics(ts.createProgram([fixture], parsed.options, host));
}

test('lifecycle outlets enforce real event payloads and require unknown forwarding', () => {
  assert.deepEqual(diagnostics(original), []);
  const unchecked = original.replace(/^\s*\/\/ @ts-expect-error.*$/gm, '');
  const failures = diagnostics(unchecked).filter(
    (value) => value.category === ts.DiagnosticCategory.Error && value.file?.fileName === fixture,
  );
  assert.equal(failures.length, 5);
});
