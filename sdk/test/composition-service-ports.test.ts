import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(root, 'src/native-services.ts');
const source = readFileSync(sourcePath, 'utf8');
function replaceOnce(before: string, after: string) {
  assert.equal(source.split(before).length - 1, 1, `Unique source anchor: ${before}`);
  return source.replace(before, after);
}
function errors(replacement: string) {
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.deepEqual(parsed.errors, []);
  const host = ts.createCompilerHost({ ...parsed.options, noEmit: true });
  const read = host.readFile.bind(host);
  host.readFile = (path) => (resolve(path) === sourcePath ? replacement : read(path));
  return ts
    .getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options, host))
    .filter((value) => value.category === ts.DiagnosticCategory.Error);
}
/** These mutations compile actual composition source, without importing or
 * executing SDK initialization or any native method. */
test('composition rejects unknown families, wrong method tuples and broad indexed service ports', () => {
  assert.deepEqual(errors(source), []);
  const cases = [
    replaceOnce(
      "callPort(service('UixConvert'), 'getUin', uids)",
      "callPort(service('Unreviewed'), 'getUin', uids)",
    ),
    replaceOnce(
      "callPort(service('UixConvert'), 'getUin', uids)",
      "callPort(service('UixConvert'), 'deleteGroupFolder', uids)",
    ),
    replaceOnce(
      "callPort(service('UixConvert'), 'getUin', uids)",
      "callPort(service('UixConvert'), 'getUin', [42])",
    ),
    replaceOnce('): NativeServicePorts[Family] =>', '): Native =>'),
  ];
  for (const replacement of cases) {
    const failures = errors(replacement);
    assert.ok(
      failures.some((value) => value.file?.fileName === sourcePath),
      'Actual composition must reject the mutation',
    );
  }
});
