import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { dependencyViolation } from '../helpers/dependency-policy.ts';
import { projectRoot, sourceRoot, files, label, graph } from '../helpers/source-graph.ts';

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

test('prepared outbound contracts own only data declarations and their reviewed peer type', () => {
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
  const tree = ts.createSourceFile(
    from,
    readFileSync(join(projectRoot, from), 'utf8'),
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
});
