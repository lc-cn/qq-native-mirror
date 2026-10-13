import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'examples/keyword-reply.ts');
const dist = resolve(root, 'dist');

function sourceToolingProgram(
  project: 'test' | 'scripts',
  extra = '',
  sourceAlias = true,
): ts.Program {
  const config = ts.readConfigFile(resolve(root, `tsconfig.${project}.json`), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.deepEqual(parsed.errors, []);
  const rootEntry =
    project === 'scripts' ? entry : resolve(root, 'test/keyword-reply-demo.test.ts');
  assert.ok(parsed.fileNames.map((file) => resolve(file)).includes(rootEntry));
  assert.equal(parsed.options.noEmit, true);
  assert.equal(parsed.options.strict, true);
  assert.equal(parsed.options.checkJs, project === 'scripts');
  if (!sourceAlias) delete parsed.options.paths;
  const host = ts.createCompilerHost(parsed.options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  const isDist = (file: string) =>
    resolve(file) === dist || resolve(file).startsWith(`${dist}${sep}`);
  host.fileExists = (file) => !isDist(file) && exists(file);
  host.readFile = (file) => {
    if (isDist(file)) return undefined;
    const source = read(file);
    return resolve(file) === entry && source !== undefined ? source + extra : source;
  };
  return ts.createProgram(parsed.fileNames, parsed.options, host);
}

for (const project of ['test', 'scripts'] as const)
  test(`${project} project reaches real examples before build and still rejects invalid reply quoting`, () => {
    const priorWithoutAlias = sourceToolingProgram(project, '', false);
    assert.ok(
      ts
        .getPreEmitDiagnostics(priorWithoutAlias)
        .some(
          (error) =>
            error.file !== undefined &&
            resolve(error.file.fileName) === entry &&
            error.code === 2307,
        ),
    );
    const good = sourceToolingProgram(project);
    const diagnostics = ts.getPreEmitDiagnostics(good);
    assert.deepEqual(
      diagnostics.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')),
      [],
    );
    const sourceNames = new Set(good.getSourceFiles().map((file) => resolve(file.fileName)));
    assert.ok(sourceNames.has(resolve(root, 'src/index.ts')));
    assert.ok(sourceNames.has(resolve(root, 'src/contracts/messages.ts')));
    assert.equal(
      good.getSourceFiles().some((file) => resolve(file.fileName).startsWith(`${dist}${sep}`)),
      false,
    );
    const bad = sourceToolingProgram(
      project,
      "\ndeclare const typeProbe: import('qq-native-client').MessageEvent;\ntypeProbe.reply('x', 'quote');\n",
    );
    assert.ok(
      ts
        .getPreEmitDiagnostics(bad)
        .some(
          (error) =>
            error.file !== undefined &&
            resolve(error.file.fileName) === entry &&
            error.code === 2345,
        ),
    );
  });

test('source-only alias does not enter production or installed declaration compiler options', () => {
  const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.paths, undefined);
  const installedVerifier = readFileSync(
    resolve(root, 'scripts/consumers/public-contract-consumer.mjs'),
    'utf8',
  );
  assert.match(installedVerifier, /const dist = join\(packageRoot, 'dist'\)/);
  assert.doesNotMatch(installedVerifier, /paths\s*:/);
});

test('standalone npm test compiles the real public entry after consumer role checks', () => {
  const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts.pretest, 'npm run check:consumer-modules && tsc');
  assert.match(scripts.test, /node --test/);
  const example = readFileSync(entry, 'utf8');
  assert.match(example, /from 'qq-native-client'/);
  const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.paths, undefined);
  assert.notEqual(parsed.options.noEmit, true);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  assert.deepEqual(
    ts
      .getPreEmitDiagnostics(program)
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')),
    [],
  );
  const emitted = new Map<string, string>();
  const result = program.emit(undefined, (file, contents) => emitted.set(resolve(file), contents));
  assert.equal(result.emitSkipped, false);
  assert.ok(emitted.has(resolve(root, 'dist/index.js')));
  assert.ok(emitted.has(resolve(root, 'dist/worker.js')));
  assert.ok(emitted.has(resolve(root, 'dist/client/message-event.js')));
  assert.ok(emitted.has(resolve(root, 'dist/index.d.ts')));
});
