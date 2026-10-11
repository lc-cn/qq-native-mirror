import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../sdk/package.json', import.meta.url));
const ts = require('typescript');
const gatePath = resolve(root, 'tools/check-native-storage.mjs');
const gate = readFileSync(gatePath, 'utf8');
function parse(path, source) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}
function declaration(program, name) {
  for (const statement of program.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const value of statement.declarationList.declarations)
      if (ts.isIdentifier(value.name) && value.name.text === name) return value.initializer;
  }
  assert.fail(`Missing actual gate declaration: ${name}`);
}
function inventory() {
  const program = parse(gatePath, gate);
  const list = declaration(program, 'sources');
  assert.ok(list && ts.isArrayLiteralExpression(list));
  return list.elements.map((item) => {
    assert.ok(ts.isStringLiteral(item), 'Inventory paths must be explicit reviewed literals');
    return item.text;
  });
}
// Inspect syntax only. Importing a production entry would prepare native artifacts.
// SDK dependencies stop at its existing directory-wide format/lint/type gates.
function missingDependencies(paths, replacement = new Map()) {
  const covered = new Set(paths);
  const missing = [];
  for (const from of paths.filter((path) => path.endsWith('.mjs'))) {
    const source = replacement.get(from) ?? readFileSync(resolve(root, from), 'utf8');
    const program = parse(from, source);
    for (const statement of program.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
      const to = relative(root, resolve(root, dirname(from), specifier.text))
        .split(sep)
        .join('/');
      if (to.startsWith('sdk/')) continue;
      if (!covered.has(to)) missing.push({ from, to });
    }
  }
  return missing;
}
await test('actual storage gate has one inventory for formatting, lint and explicit offline tests', () => {
  const paths = inventory();
  assert.equal(new Set(paths).size, paths.length);
  for (const name of [
    'ci/verified-download.mjs',
    'ci/verified-download.test.mjs',
    'ci/bundle-video-codec.mjs',
  ])
    assert.ok(paths.includes(name), name);
  const program = parse(gatePath, gate);
  assert.equal(
    declaration(program, 'offlineTests').getText(program),
    "sources.filter((path) => path.endsWith('.test.mjs'))",
  );
  const runs = program.statements
    .filter(ts.isExpressionStatement)
    .map((statement) => statement.expression)
    .filter(
      (expression) =>
        ts.isCallExpression(expression) && expression.expression.getText(program) === 'run',
    );
  assert.equal(runs.length, 4);
  for (const [index, expected] of [
    [0, '...sources'],
    [2, "...sources.filter((path) => path.endsWith('.mjs'))"],
  ]) {
    const call = runs[index];
    assert.ok(call && ts.isArrayLiteralExpression(call.arguments[0]));
    assert.ok(call.arguments[0].elements.some((item) => item.getText(program) === expected));
  }
  const last = runs.at(-1);
  assert.ok(last && ts.isArrayLiteralExpression(last.arguments[0]));
  assert.deepEqual(
    last.arguments[0].elements.map((item) => item.getText(program)),
    ["'--test'", '...offlineTests'],
  );
  assert.deepEqual(missingDependencies(paths), []);
});
await test('removing the real verified download owner fails its production import closure', () => {
  const paths = inventory().filter((path) => path !== 'ci/verified-download.mjs');
  assert.ok(
    missingDependencies(paths).some(
      (edge) => edge.from === 'ci/build-platform.mjs' && edge.to === 'ci/verified-download.mjs',
    ),
  );
});
await test('a new production dependency cannot silently inherit storage gate coverage', () => {
  const from = 'ci/build-platform.mjs';
  const modified =
    "import './unreviewed-build-helper.mjs';\n" + readFileSync(resolve(root, from), 'utf8');
  assert.ok(
    missingDependencies(inventory(), new Map([[from, modified]])).some(
      (edge) => edge.to === 'ci/unreviewed-build-helper.mjs',
    ),
  );
});
