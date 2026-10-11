import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import ts from 'typescript';
import { findAmbientFetchReferences } from './helpers/ambient-network.ts';
import { extractSourceDependencies } from './helpers/source-dependencies.ts';
import { ambientNetworkOwners } from './helpers/external-dependencies.ts';

// The fixtures are compiled for symbol resolution only. No fixture is imported,
// evaluated or allowed to make a request.
const cases = [
  ["await fetch('https://fixture.invalid')", true],
  ["await globalThis.fetch('https://fixture.invalid')", true],
  ["await globalThis['fetch']('https://fixture.invalid')", true],
  ["const request = fetch; await request('https://fixture.invalid')", true],
  ["const world = globalThis; await world.fetch('https://fixture.invalid')", true],
  ["const { fetch: request } = globalThis; await request('https://fixture.invalid')", true],
  ["const { fetch } = globalThis; await fetch('https://fixture.invalid')", true],
  ['const transport = { fetch };', true],
  ["const key = 'fetch' as const; const request = globalThis[key];", true],
  ["const key = 'fetch' as const; const { [key]: request } = globalThis;", true],
  [
    'const supplied: { fetch?: typeof fetch } = {}; const { fetch: request = fetch } = supplied;',
    true,
  ],
  ['function read(fetch: () => number) { return fetch(); }', false],
  ['const fetch = () => 1; fetch();', false],
  ['const service = { fetch: () => 1 }; service.fetch();', false],
  ['const service = { fetch: () => 1 }; const { fetch } = service; fetch();', false],
  ['const service = { fetch: () => 1 }; const { fetch: request } = service; request();', false],
  ['type Transport = typeof fetch; type GlobalTransport = typeof globalThis.fetch;', false],
  ['interface Port { fetch: typeof fetch };', false],
  ['const note = "fetch";', false],
  ["const key = 'fetch' as const; const service = { fetch: () => 1 }; service[key]();", false],
  [
    "const key = 'fetch' as const; const service = { fetch: () => 1 }; const { [key]: request } = service; request();",
    false,
  ],
] as const;
const fixtures = new Map(
  cases.map(([body], index) => [resolve(`ambient-fixture-${index}.ts`), `export {};\n${body}`]),
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

test('ambient fetch references include acquisition aliases and exclude local/type-only names', () => {
  for (const [index, [body, expected]] of cases.entries()) {
    const source = program.getSourceFile(resolve(`ambient-fixture-${index}.ts`));
    assert.ok(source);
    const references = findAmbientFetchReferences(source, checker);
    assert.equal(references.length > 0, expected, body);
    for (const reference of references) assert.ok(reference.line >= 2);
  }
});

test('a network lookup in a pure input is rejected despite having no import edge', () => {
  const path = 'src/features/groups/group-search-input.ts';
  const source = program.getSourceFile(resolve('ambient-fixture-0.ts'));
  assert.ok(source);
  assert.deepEqual(extractSourceDependencies(path, source.text).dependencies, []);
  const references = findAmbientFetchReferences(source, checker);
  assert.ok(references.length > 0);
  assert.equal(ambientNetworkOwners[path], undefined);
  for (const owner of [
    'src/native/native-catalog.ts',
    'src/native/native-package.ts',
    'src/features/groups/qun-web-read.ts',
  ])
    assert.ok(ambientNetworkOwners[owner]);
  assert.equal(ambientNetworkOwners['src/features/groups/new-input.ts'], undefined);
  assert.equal(ambientNetworkOwners['src/features/groups/group-web-reads.ts'], undefined);
});
