import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import ts from 'typescript';
import { findAmbientModuleLoadingReferences } from './helpers/ambient-module-loading.ts';
import { extractSourceDependencies } from './helpers/source-dependencies.ts';
// Fixtures are compiled for symbols only, never imported or executed.
const cases = [
  ["process.getBuiltinModule('node:fs');", true],
  ["globalThis.process.getBuiltinModule('node:fs');", true],
  ["process['getBuiltinModule']('node:fs');", true],
  ["const key='getBuiltinModule' as const; process[key]('node:fs');", true],
  ['const owner=process; const load=owner.getBuiltinModule;', true],
  ['const { getBuiltinModule: load }=process;', true],
  ['const { getBuiltinModule }=process; const transport={getBuiltinModule};', true],
  ["const key='getBuiltinModule' as const; const { [key]: load }=process;", true],
  ['type Loader=typeof process.getBuiltinModule;', false],
  ['interface Port { load: typeof process.getBuiltinModule };', false],
  ['const process={getBuiltinModule:()=>1}; process.getBuiltinModule();', false],
  ['const service={getBuiltinModule:()=>1}; const {getBuiltinModule}=service;', false],
  [
    "const key='getBuiltinModule' as const; const process={getBuiltinModule:()=>1}; process[key]();",
    false,
  ],
  [
    'function read(process:{getBuiltinModule():number}) { return process.getBuiltinModule(); }',
    false,
  ],
] as const;
const fixtures = new Map(
  cases.map(([body], index) => [
    resolve(`ambient-module-fixture-${index}.ts`),
    `export {};\n${body}`,
  ]),
);
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  types: ['node'],
  noEmit: true,
};
const host = ts.createCompilerHost(options);
const originalGetSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
  const source = fixtures.get(resolve(path));
  return source === undefined
    ? originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile)
    : ts.createSourceFile(path, source, languageVersion, true);
};
const program = ts.createProgram([...fixtures.keys()], options, host);
const checker = program.getTypeChecker();

test('ambient builtin acquisition excludes local and type-only names', () => {
  for (const [index, [body, expected]] of cases.entries()) {
    const source = program.getSourceFile(resolve(`ambient-module-fixture-${index}.ts`));
    assert.ok(source);
    const references = findAmbientModuleLoadingReferences(source, checker);
    assert.equal(references.length > 0, expected, body);
    for (const reference of references) assert.ok(reference.line >= 2);
  }
});
test('pure input builtin lookup has no import edge but is detected', () => {
  const source = program.getSourceFile(resolve('ambient-module-fixture-0.ts'));
  assert.ok(source);
  assert.deepEqual(
    extractSourceDependencies('src/features/forward/forward-resource-input.ts', source.text),
    { dependencies: [], violations: [] },
  );
  assert.ok(findAmbientModuleLoadingReferences(source, checker).length > 0);
});
