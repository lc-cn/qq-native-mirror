import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientPath = join(root, 'src/client/qq-client.ts');
const contractsPath = join(root, 'src/runtime/operation-contracts.ts');
const operationsPath = join(root, 'src/runtime/operations.ts');
const client = readFileSync(clientPath, 'utf8');
const contracts = readFileSync(contractsPath, 'utf8');
const operations = readFileSync(operationsPath, 'utf8');

function replaceOnce(source: string, before: string, after: string): string {
  assert.equal(source.split(before).length - 1, 1, `Compiler fixture anchor: ${before}`);
  return source.replace(before, after);
}

/** Compile in memory. Invalid business bodies are never executed or written. */
function diagnostics(path?: string, replacement?: string): ts.Diagnostic[] {
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.deepEqual(parsed.errors, []);
  const host = ts.createCompilerHost({ ...parsed.options, noEmit: true });
  const read = host.readFile.bind(host);
  host.readFile = (file) => (resolve(file) === path ? replacement : read(file));
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
}

test('actual internal dispatch links every command to its payload and result without widening', () => {
  assert.deepEqual(diagnostics(), [], 'The actual source must compile before negative fixtures.');
  const cases = [
    ['captureFriendCategoryAssignment(userId, categoryId)', "{ userId, categoryId: '7' }"],
    ["this.#operation('listFriends')", "this.#operation('listGroups')"],
    [
      "this.#operation('setGroupMute', { groupId, enabled })",
      "this.#operation('setGroupMute', { groupId, enabled: 'yes' })",
    ],
    ['captureRecallRequest(peer, messageId)', '{ peer }'],
    ["this.#operation('listFriends')", "this.#operation('listFriends', { groupId: '123' })"],
    [
      "this.#operation('setGroupMute', { groupId, enabled })",
      "this.#operation(enabled ? 'setGroupMute' : 'setGroupName', { groupId, enabled })",
    ],
    ['options: captured.params,', 'options: { folderId: captured.params.folderId },'],
    ["this.#operation('reorderFriendCategories', {", "this.#operation('deleteFriendCategory', {"],
    [
      'options: { pageStart: query.pageStart, pageLimit: query.pageLimit },',
      'options: { pageStart: query.pageStart },',
    ],
  ];
  for (const [before, after] of cases) {
    const errors = diagnostics(clientPath, replaceOnce(client, before!, after!));
    assert.ok(
      errors.some((d) => d.file && resolve(d.file.fileName) === clientPath),
      `The real facade must reject ${after}`,
    );
  }
});

test('command vocabulary and type contracts are complete in both directions', () => {
  const extraOperation = replaceOnce(
    operations,
    "  'addFriendCategory',",
    "  'unimplementedOperation',\n  'addFriendCategory',",
  );
  assert.ok(
    diagnostics(operationsPath, extraOperation).some(
      (d) => d.file && resolve(d.file.fileName) === contractsPath,
    ),
    'A routing name without payload/result contracts must fail compilation.',
  );
  const extraContract = replaceOnce(
    contracts,
    'export interface ServiceOperationContracts {',
    'export interface ServiceOperationContracts {\n  unregisteredOperation: Operation<undefined, void>;',
  );
  assert.ok(
    diagnostics(contractsPath, extraContract).some(
      (d) => d.file && resolve(d.file.fileName) === contractsPath,
    ),
    'An orphan contract without a registered command must fail compilation.',
  );
});

test('internal operation contracts remain declarations with type-only domain dependencies', () => {
  const source = ts.createSourceFile(contractsPath, contracts, ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) assert.equal(statement.importClause?.isTypeOnly, true);
    else
      assert.ok(
        ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement),
        'Command contracts must not acquire resources or manufacture native runtime facts.',
      );
  }
});
