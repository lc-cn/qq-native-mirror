import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { getFileInfo } from 'prettier';
import { extractSourceDependencies } from './helpers/source-dependencies.ts';
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
  const extracted = extractSourceDependencies(label(path), readFileSync(path, 'utf8'));
  assert.deepEqual(extracted.violations, [], extracted.violations.join('\n'));
  return extracted.dependencies.map((edge) => ({
    ...edge,
    ...(edge.specifier.startsWith('.') ? { target: relativeTarget(path, edge.specifier) } : {}),
  }));
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
    ['src/validation/identifiers.ts', 'src/features/messages/send-input.ts'],
    ['src/validation/identifiers.ts', 'src/runtime/client-lifecycle.ts'],
    ['src/features/groups/group-file-input.ts', 'src/features/messages/send-input.ts'],
    ['src/features/groups/group-essence-input.ts', 'src/features/messages/send-input.ts'],
    ['src/features/groups/new-action.ts', 'src/index.ts'],
    ['src/features/groups/new-action.ts', 'src/kernel.ts'],
    ['src/features/groups/new-action.ts', 'src/native/native-package.ts'],
    ['src/features/groups/new-action.ts', 'src/runtime/client-lifecycle.ts'],
    ['src/features/contacts/self-profile.ts', 'src/runtime/native-service-context.ts'],
    ['src/features/contacts/self-profile.ts', 'src/runtime/account-session-lifecycle.ts'],
    ['src/features/groups/group-requests.ts', 'src/runtime/native-service-context.ts'],
    ['src/features/groups/group-requests.ts', 'src/runtime/account-session-lifecycle.ts'],
    ['src/features/groups/group-notices.ts', 'src/runtime/native-service-context.ts'],
    ['src/features/groups/group-notices.ts', 'src/runtime/account-session-lifecycle.ts'],
    ['src/features/contacts/new-profile.ts', 'src/runtime/cleanup.ts'],
    ['src/features/messages/native-message-sender.ts', 'src/runtime/native-service-context.ts'],
    ['src/features/groups/new-action.ts', 'src/runtime/native-service-context.ts'],
    ['src/features/groups/new-action.ts', 'src/features/media/media-send.ts'],
    ['src/runtime/new-owner.ts', 'src/features/media/media-send.ts'],
    ['src/runtime/account-session-lifecycle.ts', 'src/native-services.ts'],
    ['src/runtime/account-session-lifecycle.ts', 'src/kernel.ts'],
    ['src/runtime/authentication-attempt.ts', 'src/kernel.ts'],
    ['src/runtime/authentication-attempt.ts', 'src/native-services.ts'],
    ['src/runtime/authentication-attempt.ts', 'src/native/native-package.ts'],
    ['src/native/new-bundle.ts', 'src/runtime/client-lifecycle.ts'],
    ['src/native/native-bundle-installer.ts', 'src/native/native-package.ts'],
    ['src/native/native-bundle-installer.ts', 'src/native/native-catalog.ts'],
    ['src/native/native-bundle-installer.ts', 'src/native/native-installed-storage.ts'],
    ['src/native/native-bundle-installer.ts', 'node:http'],
    ['src/native/new-bundle.ts', 'src/native/native-bundle-installer.ts'],
    ['src/storage/native-package-lock.ts', 'src/native/native-package.ts'],
    ['src/storage/native-package-lock.ts', 'node:child_process'],
    ['src/storage/new-store.ts', 'src/native/native-package.ts'],
    ['src/index.ts', 'src/features/groups/group-operations.ts'],
    ['src/index.ts', 'src/runtime/client-lifecycle.ts'],
    ['src/client/qq-client.ts', 'src/native/native-package.ts'],
    ['src/client/qq-client.ts', 'src/client/create-client.ts'],
    ['src/client/qq-client.ts', 'node:fs'],
    ['src/client/create-client.ts', 'src/kernel.ts'],
    ['src/client/new-facade.ts', 'src/runtime/client-lifecycle.ts'],
    ['src/client/new-facade.ts', 'node:fs'],
    ['src/kernel.ts', 'src/client/qq-client.ts'],
    ['src/kernel.ts', 'src/features/groups/group-operations.ts'],
    ['src/kernel.ts', 'src/storage/data-directory-lock.ts'],
    ['src/kernel.ts', 'node:fs/promises'],
    ['src/worker.ts', 'src/native-services.ts'],
    ['src/worker.ts', 'src/features/groups/group-operations.ts'],
    ['src/native-services.ts', 'src/kernel.ts'],
    ['src/native-services.ts', 'src/runtime/kernel-environment.ts'],
    ['src/native-services.ts', 'src/native/native-package.ts'],
    ['src/native-services.ts', 'src/storage/data-directory-lock.ts'],
    ['src/runtime/kernel-environment.ts', 'src/kernel.ts'],
    ['src/runtime/kernel-environment.ts', 'src/native-services.ts'],
    ['src/runtime/kernel-environment.ts', 'node:child_process'],
    ['src/native-services.ts', 'src/client/create-client.ts'],
    ['src/unowned.ts', 'src/runtime/client-lifecycle.ts'],
    ['src/contracts/groups.ts', 'src/features/groups/group-queries.ts'],
    ['src/contracts/groups.ts', 'src/contracts/events.ts'],
    ['src/contracts/messages.ts', 'src/contracts/forward.ts'],
    ['src/contracts/new-domain.ts', 'src/contracts/client.ts'],
    ['src/contracts/client.ts', 'src/index.ts'],
    ['src/runtime/new-owner.ts', 'src/types.ts'],
    ['src/features/groups/new-action.ts', 'src/types.ts'],
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

test('package entry contains only public reexports and resource owners use explicit IO dependencies', () => {
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
  for (const [path, edges] of graph) {
    if (
      !label(path).startsWith('src/client/') &&
      ![
        'src/native/native-bundle-installer.ts',
        'src/storage/native-package-lock.ts',
        'src/runtime/kernel-environment.ts',
        'src/kernel.ts',
        'src/native-services.ts',
        'src/worker.ts',
      ].includes(label(path))
    )
      continue;
    for (const edge of edges) {
      if (edge.target) continue;
      assert.equal(
        dependencyViolation({ from: label(path), to: edge.specifier, typeOnly: edge.typeOnly }),
        undefined,
        `${label(path)} → ${edge.specifier}: unreviewed owner IO dependency`,
      );
    }
  }
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

// This list describes reviewed pure modules, not permitted dependencies of general
// composition modules. Adding an input helper requires reviewing its runtime closure.
const pureModules = new Set([
  'src/types.ts',
  'src/errors.ts',
  'src/validation/identifiers.ts',
  'src/features/contacts/friend-categories.ts',
  'src/features/messages/query-input.ts',
  'src/features/groups/group-essence-input.ts',
  'src/features/groups/group-file-input.ts',
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
  'validation/identifiers.ts',
  'features/groups/group-essence-input.ts',
  'features/groups/group-file-input.ts',
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

test('module loading extraction rejects computed imports and CommonJS aliases outside exact loaders', () => {
  for (const text of [
    'import(target)',
    'import(`./${name}.js`)',
    'require("./hidden")',
    'require.resolve("./hidden")',
    'require["resolve"]("./hidden")',
    'const r=require; r("x")',
    'import {createRequire as factory} from "node:module"; const r=factory(import.meta.url); r.resolve("x")',
    'const {resolve:lookup}=require; lookup("x")',
  ]) {
    assert.ok(
      extractSourceDependencies('src/features/fixture.ts', text).violations.length > 0,
      text,
    );
  }
  const literal = extractSourceDependencies('src/features/fixture.ts', 'import("./child.js")');
  assert.deepEqual(
    literal.dependencies.map((edge) => [edge.specifier, edge.typeOnly]),
    [['./child.js', false]],
  );
  for (const [path, text] of [
    ['src/features/media/record-codec-loader.ts', 'import(pathToFileURL(file).href)'],
    ['src/features/media/video-codec-loader.ts', 'createRequire(import.meta.url)(file)'],
    [
      'src/native/native-package.ts',
      'createRequire(import.meta.url).resolve(`${name}/manifest.json`)',
    ],
  ]) {
    assert.deepEqual(extractSourceDependencies(path!, text!).violations, []);
    assert.ok(extractSourceDependencies('src/features/new-loader.ts', text!).violations.length > 0);
  }
  assert.ok(
    extractSourceDependencies(
      'src/features/media/video-codec-loader.ts',
      'createRequire(import.meta.url)(other)',
    ).violations.length > 0,
  );
});
