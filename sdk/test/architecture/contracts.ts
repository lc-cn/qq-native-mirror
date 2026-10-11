import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { dependencyViolation } from '../helpers/dependency-policy.ts';
import {
  projectRoot,
  sourceRoot,
  files,
  label,
  graph,
  relativeTarget,
} from '../helpers/source-graph.ts';

test('group-file compatibility exports cannot reacquire protocol execution', () => {
  const path = join(sourceRoot, 'features/groups/group-file-operations.ts');
  const tree = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  assert.ok(tree.statements.length > 0);
  for (const statement of tree.statements) {
    assert.ok(ts.isExportDeclaration(statement) && statement.moduleSpecifier);
    assert.ok(
      ts.isStringLiteral(statement.moduleSpecifier) &&
        ['./group-file-count.ts', './group-folder-operations.ts'].includes(
          statement.moduleSpecifier.text,
        ),
      'The compatibility barrel only reexports the owned count and folder protocols',
    );
  }
});

test('package entry contains only public reexports', () => {
  const entry = join(sourceRoot, 'index.ts');
  const tree = ts.createSourceFile(
    entry,
    readFileSync(entry, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  assert.ok(tree.statements.length > 0);
  for (const statement of tree.statements)
    assert.ok(
      ts.isExportDeclaration(statement) && statement.moduleSpecifier,
      'The package entry must not acquire resources or implement client behavior.',
    );
});

test('public contracts contain declarations only, including newly added domain files', () => {
  for (const path of files.filter(
    (path) => label(path).startsWith('src/contracts/') || label(path) === 'src/types.ts',
  )) {
    const tree = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of tree.statements) {
      const declaration =
        ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
      const typeImport = ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly;
      const typeExport = ts.isExportDeclaration(statement) && statement.isTypeOnly;
      assert.ok(
        declaration || typeImport || typeExport,
        `${label(path)}: contracts must not execute code or declare concrete classes/enums`,
      );
      if (label(path) === 'src/types.ts')
        assert.ok(typeExport, 'The compatibility barrel must not own declarations or imports');
    }
    for (const edge of graph.get(path)!) {
      assert.ok(
        edge.typeOnly && edge.target,
        `${label(path)}: unreviewed external contract import`,
      );
      assert.equal(
        dependencyViolation({ from: label(path), to: label(edge.target!), typeOnly: true }),
        undefined,
      );
    }
  }
  assert.deepEqual(graph.get(join(sourceRoot, 'errors.ts')), []);
});

test('public contract type dependencies have no cycles', () => {
  const complete = new Set<string>();
  const active = new Set<string>();
  function walk(path: string) {
    assert.ok(!active.has(path), `Contract type cycle at ${label(path)}`);
    if (complete.has(path)) return;
    active.add(path);
    for (const edge of graph.get(path)!) if (edge.target) walk(edge.target);
    active.delete(path);
    complete.add(path);
  }
  for (const path of files.filter((path) => label(path).startsWith('src/contracts/'))) walk(path);
});

test('outbound native contracts own closed data declarations and their reviewed peer type', () => {
  const from = 'src/native/prepared-message-contracts.ts';
  for (const to of [
    'src/native/native-object.ts',
    'src/native/native-contracts.ts',
    'src/runtime/media-contracts.ts',
  ])
    for (const typeOnly of [true, false]) assert.ok(dependencyViolation({ from, to, typeOnly }));
  assert.equal(
    dependencyViolation({ from, to: 'src/native/message-contracts.ts', typeOnly: true }),
    undefined,
  );
  assert.ok(dependencyViolation({ from, to: 'src/native/message-contracts.ts', typeOnly: false }));
  const peer = 'src/native/message-contracts.ts';
  assert.deepEqual(graph.get(join(projectRoot, peer)), []);
  for (const to of ['src/native/native-object.ts', from, 'node:fs'])
    for (const typeOnly of [true, false])
      assert.ok(dependencyViolation({ from: peer, to, typeOnly }));
  for (const path of [from, peer]) {
    const tree = ts.createSourceFile(
      path,
      readFileSync(join(projectRoot, path), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of tree.statements) {
      if (ts.isImportDeclaration(statement)) {
        assert.equal(statement.importClause?.isTypeOnly, true);
        continue;
      }
      assert.ok(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement));
      if (ts.isInterfaceDeclaration(statement)) {
        assert.equal(
          statement.heritageClauses,
          undefined,
          'Constructed DTOs do not inherit dynamic native objects',
        );
        assert.equal(statement.members.some(ts.isIndexSignatureDeclaration), false);
      }
    }
  }
});

test('contact profile compatibility names reuse the canonical public DTO and query port', () => {
  const path = join(sourceRoot, 'features/contacts/contact-operations.ts');
  const tree = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  assert.ok(
    !tree.statements.some(
      (statement) =>
        (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
        ['ContactProfile', 'ContactProfilePort'].includes(statement.name.text),
    ),
  );
  const exports = tree.statements.filter(ts.isExportDeclaration);
  for (const [name, original, module] of [
    ['ContactProfile', 'UserProfile', '../../contracts/contacts.ts'],
    ['ContactProfilePort', 'ContactProfilePort', './user-profile-query.ts'],
  ]) {
    assert.ok(
      exports.some(
        (statement) =>
          statement.isTypeOnly &&
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text === module &&
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.some(
            (element) =>
              element.name.text === name &&
              (element.propertyName?.text ?? element.name.text) === original,
          ),
      ),
    );
  }
});

test('validated message query envelope does not inherit an unbounded native object', () => {
  const path = join(sourceRoot, 'features/messages/message-query.ts');
  const tree = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const envelope = tree.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === 'QueriedNativeMessage',
  );
  assert.ok(envelope);
  assert.equal(envelope.heritageClauses, undefined);
  assert.equal(envelope.members.some(ts.isIndexSignatureDeclaration), false);
});

// The creation root may initialize the private inventory, but consumers must not
// acquire that publisher through a namespace or a public reexport.
function nativeExportPublisherViolations(path: string, source: string): string[] {
  const publisher = 'completeClientInitialization';
  const creator = join(sourceRoot, 'client/create-client.ts');
  const client = join(sourceRoot, 'client/qq-client.ts');
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const localPublishers = new Set<string>();
  const targetsClient = (node: ts.Expression) =>
    ts.isStringLiteral(node) && relativeTarget(path, node.text) === client;
  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement) && targetsClient(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings) && !clause?.isTypeOnly)
        violations.push('Client runtime namespace exposes the private publisher');
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          if ((element.propertyName?.text ?? element.name.text) === publisher) {
            localPublishers.add(element.name.text);
            if (path !== creator || clause?.isTypeOnly || element.isTypeOnly)
              violations.push('Only the creation root may import the runtime publisher');
          }
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      targetsClient(statement.moduleSpecifier)
    ) {
      const clause = statement.exportClause;
      if (!clause || !ts.isNamedExports(clause))
        violations.push('Client namespace/star reexports expose the private publisher');
      else if (
        clause.elements.some(
          (element) => (element.propertyName?.text ?? element.name.text) === publisher,
        )
      )
        violations.push('The private publisher cannot be reexported');
    }
  }
  function referencesPublisher(node: ts.Node): boolean {
    if (ts.isIdentifier(node) && localPublishers.has(node.text)) return true;
    return ts.forEachChild(node, referencesPublisher) ?? false;
  }
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      targetsClient(node.arguments[0])
    )
      violations.push('Dynamic client namespace exposes the private publisher');
    if (
      ts.isExportDeclaration(node) &&
      !node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.some((element) =>
        localPublishers.has(element.propertyName?.text ?? element.name.text),
      )
    )
      violations.push('The imported private publisher cannot be exported locally');
    if (ts.isExportAssignment(node) && referencesPublisher(node.expression))
      violations.push('The imported private publisher cannot become a default export');
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
      referencesPublisher(node.declarationList)
    )
      violations.push('The imported private publisher cannot become an exported value');
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return violations;
}

test('native export inventory publisher is restricted to the named creation-root import', () => {
  for (const path of files)
    assert.deepEqual(
      nativeExportPublisherViolations(path, readFileSync(path, 'utf8')),
      [],
      label(path),
    );
});

test('native export publisher gate rejects namespace and public reexport bypasses', () => {
  const creator = join(sourceRoot, 'client/create-client.ts');
  const entry = join(sourceRoot, 'index.ts');
  assert.deepEqual(
    nativeExportPublisherViolations(
      creator,
      "import { completeClientInitialization as publish, QQClient } from './qq-client.ts';",
    ),
    [],
  );
  assert.deepEqual(
    nativeExportPublisherViolations(entry, "export { QQClient } from './client/qq-client.ts';"),
    [],
  );
  for (const source of [
    "import { completeClientInitialization as publish } from './client/qq-client.ts';",
    "import * as client from './client/qq-client.js';",
    "export { completeClientInitialization as publish } from './client/qq-client.ts';",
    "export * from './client/qq-client.ts';",
    "export * as client from './client/qq-client.ts';",
    "const client = import('./client/qq-client.ts');",
  ])
    assert.ok(nativeExportPublisherViolations(entry, source).length > 0, source);
  assert.ok(
    nativeExportPublisherViolations(
      creator,
      "import { completeClientInitialization as publish } from './qq-client.ts'; export { publish as initialize }; ",
    ).length > 0,
  );
});
