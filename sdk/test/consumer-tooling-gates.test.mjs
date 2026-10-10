import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { ESLint } from 'eslint';
import { collectConsumerModuleReferences } from '../scripts/consumer-module-references.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helper = resolve(root, 'scripts/face-consumer-contract.mjs');
const source = readFileSync(helper, 'utf8');
function replaceOnce(value, before, after) {
  assert.equal(value.split(before).length - 1, 1, `Fixture anchor must occur once: ${before}`);
  return value.replace(before, after);
}
function diagnostics(replacement) {
  const configPath = resolve(root, 'tsconfig.scripts.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.deepEqual(parsed.errors, []);
  const host = ts.createCompilerHost(parsed.options);
  const originalRead = host.readFile.bind(host);
  host.readFile = (path) => (resolve(path) === helper ? replacement : originalRead(path));
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((item) => item.file && resolve(item.file.fileName) === helper);
}

test('consumer compiler gate rejects missing preparation await and fabricated send receipts without running the helper', () => {
  assert.deepEqual(diagnostics(source), [], 'Actual checked helper must be type-correct first');
  const missingAwait = replaceOnce(
    source,
    'const action = await prepareCommand(',
    'const action = prepareCommand(',
  );
  const errors = diagnostics(missingAwait);
  assert.ok(
    errors.some((item) => item.code === 2349),
    'Promise action must not be callable',
  );
  const wrongReceipt = replaceOnce(
    source,
    "return { messageId: '1', sequence: '1', time: 1 };",
    'return undefined;',
  );
  assert.ok(
    diagnostics(wrongReceipt).some((item) => item.code === 2322),
    'Fake send must retain public receipt contract',
  );
});

test('typed consumer lint rejects unobserved action Promise without spawning its fake client', async () => {
  const eslint = new ESLint({
    cwd: root,
    // These lintText calls repeatedly change one in-memory file. CI single-run
    // inference treats later parses as autofixes and loses imported action types.
    // Use the persistent program only here; the actual disk lint gate is unchanged.
    overrideConfig: {
      languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } },
    },
  });
  const good = await eslint.lintText(source, { filePath: helper });
  assert.equal(good[0].errorCount, 0, 'Actual checked helper must pass its lint gate first');
  for (const invocation of ['action(client);', 'void action(client);']) {
    const missingAwait = replaceOnce(source, 'await action(client);', invocation);
    const results = await eslint.lintText(missingAwait, { filePath: helper });
    assert.ok(
      results[0].messages.some(
        (message) => message.ruleId === '@typescript-eslint/no-floating-promises',
      ),
      `Unobserved action must reject: ${invocation}`,
    );
  }
});

test('collector never executes consumers or scans excluded account executors, and rejects root escape/computed import', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'consumer-static-gate-')));
  try {
    const helpers = join(directory, 'helpers'),
      dist = join(directory, 'dist');
    await mkdir(helpers);
    await mkdir(dist);
    const entry = join(helpers, 'entry.mjs'),
      marker = join(directory, 'executed-marker');
    await writeFile(entry, `throw Error('consumer must never execute'); import './safe.mjs';`);
    await writeFile(
      join(helpers, 'safe.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe'); throw Error('helper must never execute');`,
    );
    await writeFile(
      join(helpers, 'account-executor.mjs'),
      `import(computedAccountPath); throw Error('excluded executor must never be scanned');`,
    );
    const options = { entries: [entry], helperRoots: [helpers], distRoot: dist };
    const collected = collectConsumerModuleReferences(options);
    assert.deepEqual(collected.helpers.map((path) => path.split(/[/\\]/).at(-1)).sort(), [
      'entry.mjs',
      'safe.mjs',
    ]);
    assert.equal(existsSync(marker), false);
    await writeFile(join(directory, 'outside.mjs'), `throw Error('not executed');`);
    await writeFile(entry, `import '../outside.mjs';`);
    assert.throws(() => collectConsumerModuleReferences(options), /escapes reviewed roots/);
    await writeFile(entry, `const path = './safe.mjs'; import(path);`);
    assert.throws(() => collectConsumerModuleReferences(options), /[Cc]omputed.*import/);
    assert.equal(existsSync(marker), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
