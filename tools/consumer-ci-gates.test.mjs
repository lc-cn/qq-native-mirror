import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../sdk/package.json', import.meta.url));
const ts = require('typescript');
const { ESLint } = require('eslint');

// Parse the actual programs, never import their native-executing entry points.
function diagnostics(file, replacement) {
  const configPath = resolve(root, 'tools/tsconfig.consumer-ci.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, 'tools'));
  assert.deepEqual(parsed.errors, []);
  const host = ts.createCompilerHost(parsed.options);
  const original = host.readFile;
  host.readFile = (path) => (resolve(path) === file ? replacement : original(path));
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  return ts.getPreEmitDiagnostics(program).map((item) => ({
    code: item.code,
    file: item.file?.fileName,
    message: ts.flattenDiagnosticMessageText(item.messageText, ' '),
  }));
}
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, `Fixture anchor must occur once: ${before}`);
  return source.replace(before, after);
}

await test('actual CI receipts require completed results rather than assigned promises', () => {
  for (const [entry, awaited] of [
    ['ci/verify-consumer.mjs', 'await verifyWorkerBootstrapConsumer(installedRoot)'],
    ['ci/current-source-mirror.mjs', 'await verifyMirrorConsumer({'],
  ]) {
    const file = resolve(root, entry);
    const actual = readFileSync(file, 'utf8');
    assert.deepEqual(diagnostics(file, actual), []);
    const missing = replaceOnce(actual, awaited, awaited.replace('await ', ''));
    assert.ok(
      diagnostics(file, missing).some(
        (item) => item.code === 2740 && item.file === file && item.message.includes('Promise<'),
      ),
    );
  }
});

await test('CI cleanup promise must be observed before the entry finishes', async () => {
  const file = resolve(root, 'ci/verify-consumer.mjs');
  const actual = readFileSync(file, 'utf8');
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: resolve(root, 'tools/eslint.config.mjs'),
    overrideConfig: {
      languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } },
    },
  });
  const good = await eslint.lintText(actual, { filePath: file });
  assert.equal(good[0].errorCount, 0);
  for (const ignored of ['closeConsumerResources(', 'void closeConsumerResources(']) {
    const broken = replaceOnce(actual, 'await closeConsumerResources(', ignored);
    const result = await eslint.lintText(broken, { filePath: file });
    assert.ok(
      result[0].messages.some((item) => item.ruleId === '@typescript-eslint/no-floating-promises'),
    );
  }
});

await test('CI npm tuple keeps process arguments separate from the executable', () => {
  const file = resolve(root, 'ci/current-source-mirror.mjs');
  const actual = readFileSync(file, 'utf8');
  assert.deepEqual(diagnostics(file, actual), []);
  const broken = replaceOnce(actual, 'npm[0],', '42,');
  assert.ok(
    diagnostics(file, broken).some(
      (item) => item.file === file && [2345, 2769].includes(item.code),
    ),
  );
});
