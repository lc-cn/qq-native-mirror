import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { getFileInfo } from 'prettier';
import { crossFeatureDependencies, dependencyViolation } from './helpers/dependency-policy.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(projectRoot, 'src');
interface Dependency {
  specifier: string;
  typeOnly: boolean;
  line: number;
  target?: string;
}
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.isFile() && path.endsWith('.ts')
        ? [path]
        : [];
  });
}
const files = sourceFiles(sourceRoot).sort();
const fileSet = new Set(files);
const label = (path: string) => relative(projectRoot, path).replaceAll('\\', '/');
function relativeTarget(from: string, specifier: string): string | undefined {
  const path = resolve(dirname(from), specifier);
  const candidates = [path, path.replace(/\.js$/, '.ts'), `${path}.ts`, join(path, 'index.ts')];
  return candidates.find((candidate) => fileSet.has(candidate));
}
function dependencies(path: string): Dependency[] {
  const tree = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const result: Dependency[] = [];
  function add(node: ts.Node, specifier: string, typeOnly: boolean) {
    result.push({
      specifier,
      typeOnly,
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      ...(specifier.startsWith('.') ? { target: relativeTarget(path, specifier) } : {}),
    });
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyNamedTypes =
        !clause?.name &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((entry) => entry.isTypeOnly);
      add(node, node.moduleSpecifier.text, clause?.isTypeOnly === true || onlyNamedTypes === true);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      const onlyNamedTypes =
        clause &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((entry) => entry.isTypeOnly);
      add(node, node.moduleSpecifier.text, node.isTypeOnly || onlyNamedTypes === true);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      add(node, node.argument.literal.text, true);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      add(node, node.arguments[0]!.text, false);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return result;
}
const graph = new Map(files.map((path) => [path, dependencies(path)]));
const runtimeEdges = (path: string) => graph.get(path)!.filter((edge) => !edge.typeOnly);

test('source dependency direction includes type-only imports and exact cross-feature collaboration', () => {
  const observed = new Set<string>();
  for (const [path, edges] of graph) {
    for (const edge of edges) {
      if (!edge.target) continue;
      const from = label(path),
        to = label(edge.target);
      observed.add(`${from} → ${to}`);
      assert.equal(
        dependencyViolation({ from, to, typeOnly: edge.typeOnly }),
        undefined,
        `${from}:${edge.line} → ${to}: ${dependencyViolation({ from, to, typeOnly: edge.typeOnly })}`,
      );
    }
  }
  for (const { from, to, reason } of crossFeatureDependencies) {
    assert.ok(reason.length > 0);
    assert.ok(observed.has(`${from} → ${to}`), `Remove obsolete collaboration ${from} → ${to}`);
  }
});

test('dependency policy rejects reverse, type-only and new cross-domain coupling', () => {
  for (const [from, to] of [
    ['src/features/groups/new-action.ts', 'src/index.ts'],
    ['src/features/groups/new-action.ts', 'src/kernel.ts'],
    ['src/features/groups/new-action.ts', 'src/native/native-package.ts'],
    ['src/features/groups/new-action.ts', 'src/runtime/client-lifecycle.ts'],
    ['src/features/groups/new-action.ts', 'src/features/media/media-send.ts'],
    ['src/runtime/new-owner.ts', 'src/features/media/media-send.ts'],
    ['src/native/new-bundle.ts', 'src/runtime/client-lifecycle.ts'],
    ['src/storage/new-store.ts', 'src/native/native-package.ts'],
    ['src/index.ts', 'src/features/groups/group-operations.ts'],
    ['src/unowned.ts', 'src/runtime/client-lifecycle.ts'],
  ]) {
    for (const typeOnly of [false, true])
      assert.ok(dependencyViolation({ from: from!, to: to!, typeOnly }), `${from} → ${to}`);
  }
  assert.equal(
    dependencyViolation({ from: 'src/cli/client-command.ts', to: 'src/index.ts', typeOnly: true }),
    undefined,
  );
  assert.equal(
    dependencyViolation({
      from: 'src/features/groups/new-action.ts',
      to: 'src/runtime/media-contracts.ts',
      typeOnly: true,
    }),
    undefined,
  );
  assert.ok(
    dependencyViolation({
      from: 'src/features/groups/new-action.ts',
      to: 'src/runtime/media-contracts.ts',
      typeOnly: false,
    }),
  );
});

test('all relative source imports and exports resolve, including type-only dependencies', () => {
  const diagnostics = ts
    .createProgram(files, { noResolve: true, noLib: true })
    .getSyntacticDiagnostics();
  assert.equal(
    diagnostics.length,
    0,
    diagnostics
      .map(
        (diagnostic) =>
          `${diagnostic.file ? label(diagnostic.file.fileName) : 'source'}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
      )
      .join('\n'),
  );
  for (const [path, edges] of graph) {
    for (const edge of edges) {
      if (edge.specifier.startsWith('.'))
        assert.ok(
          edge.target,
          `${label(path)}:${edge.line} → ${edge.specifier}: relative source target does not exist`,
        );
    }
  }
});

test('public types and error primitives do not import implementation modules', () => {
  for (const name of ['types.ts', 'errors.ts']) {
    const path = join(sourceRoot, name);
    for (const edge of graph.get(path)!) {
      if (!edge.target) continue;
      assert.ok(
        name === 'errors.ts' && edge.target === join(sourceRoot, 'types.ts'),
        `${label(path)}:${edge.line} → ${label(edge.target)}: public primitives must not depend on implementation`,
      );
    }
  }
});

// This list describes reviewed pure modules, not permitted dependencies of general
// composition modules. Adding an input helper requires reviewing its runtime closure.
const pureModules = new Set([
  'src/types.ts',
  'src/errors.ts',
  'src/features/contacts/friend-categories.ts',
  'src/features/messages/query-input.ts',
  'src/features/media/download-input.ts',
  'src/features/forward/merged-forward-input.ts',
  'src/features/messages/send-input.ts',
  'src/features/messages/face-input.ts',
  'src/features/messages/qq-faces.ts',
  'src/features/forward/long-message-request.ts',
  'src/features/forward/merged-forward-card.ts',
]);
const pureRoots = [
  'features/contacts/friend-categories.ts',
  'features/messages/query-input.ts',
  'features/media/download-input.ts',
  'features/forward/merged-forward-input.ts',
  'features/messages/send-input.ts',
  'features/messages/face-input.ts',
];
const pureBuiltins = new Set(['node:path', 'node:crypto', 'node:zlib', 'node:buffer', 'node:util']);
test('input validation runtime closures stay pure and do not load service operations or IO', () => {
  for (const name of pureRoots) {
    const visited = new Set<string>();
    function walk(path: string, trail: string[]) {
      if (visited.has(path)) return;
      visited.add(path);
      assert.ok(graph.has(path), `Missing required pure root ${label(path)}`);
      for (const edge of runtimeEdges(path)) {
        const chain = [...trail, edge.target ? label(edge.target) : edge.specifier];
        const explanation = `${chain.join(' → ')} (import at ${label(path)}:${edge.line})`;
        if (edge.target) {
          assert.ok(
            pureModules.has(label(edge.target)),
            `${explanation}: dependency is not a reviewed pure input/wire/projection module`,
          );
          walk(edge.target, chain);
        } else
          assert.ok(
            pureBuiltins.has(edge.specifier),
            `${explanation}: IO or unreviewed external runtime dependency in pure input closure`,
          );
      }
    }
    const root = join(sourceRoot, name);
    walk(root, [label(root)]);
  }
});

test('relative runtime source dependencies have no cycles', () => {
  const complete = new Set<string>();
  const active: string[] = [];
  function walk(path: string) {
    const index = active.indexOf(path);
    assert.equal(
      index,
      -1,
      `Runtime dependency cycle: ${[...active.slice(index < 0 ? 0 : index), path].map(label).join(' → ')}`,
    );
    if (complete.has(path)) return;
    active.push(path);
    for (const edge of runtimeEdges(path)) if (edge.target) walk(edge.target);
    active.pop();
    complete.add(path);
  }
  for (const path of files) walk(path);
});

// Binary bundles are ignored only at the package root. A basename ignore such as
// native/ would silently exclude src/native/ from the mandatory formatting gate.
test('every TypeScript source module participates in the formatting gate', async () => {
  const results = await Promise.all(
    files.map(async (path) => ({
      path,
      info: await getFileInfo(path, { ignorePath: join(projectRoot, '.prettierignore') }),
    })),
  );
  for (const { path, info } of results) {
    assert.equal(info.ignored, false, `${label(path)} is silently excluded from formatting`);
    assert.equal(info.inferredParser, 'typescript', `${label(path)} has no TypeScript formatter`);
  }
});
