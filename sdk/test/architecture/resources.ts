import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { getFileInfo } from 'prettier';
import { findAmbientFetchReferences } from '../helpers/ambient-network.ts';
import { findAmbientModuleLoadingReferences } from '../helpers/ambient-module-loading.ts';
import { dependencyViolation } from '../helpers/dependency-policy.ts';
import {
  externalRuntimeDependencies,
  externalTypeDependencies,
  ambientNetworkOwners,
} from '../helpers/external-dependencies.ts';
import {
  projectRoot,
  sourceRoot,
  files,
  label,
  graph,
  runtimeEdges,
} from '../helpers/source-graph.ts';

// This list describes reviewed pure modules, not permitted dependencies of general
// composition modules. Adding an input helper requires reviewing its runtime closure.
const pureModules = new Set([
  'src/features/contacts/friend-request-input.ts',
  'src/features/groups/group-request-input.ts',
  'src/features/contacts/contact-operation-input.ts',
  'src/features/groups/group-operation-input.ts',
  'src/native/native-manifest.ts',
  'src/native/native-contracts.ts',
  'src/types.ts',
  'src/errors.ts',
  'src/validation/identifiers.ts',
  'src/features/contacts/friend-categories.ts',
  'src/features/contacts/friend-category-input.ts',
  'src/features/messages/query-input.ts',
  'src/features/messages/recall-input.ts',
  'src/features/groups/group-essence-input.ts',
  'src/features/groups/files/group-file-input.ts',
  'src/features/groups/group-search-input.ts',
  'src/features/groups/group-avatar-input.ts',
  'src/features/groups/group-member-query-input.ts',
  'src/features/media/download-input.ts',
  'src/features/forward/merged-forward-input.ts',
  'src/features/forward/forward-input.ts',
  'src/features/messages/send-input.ts',
  'src/features/messages/face-input.ts',
  'src/features/messages/inbound-elements.ts',
  'src/features/forward/received-forward.ts',
  'src/features/messages/qq-faces.ts',
  'src/features/forward/long-message-request.ts',
  'src/features/forward/forward-resource-input.ts',
  'src/features/forward/forward-resource-wire.ts',
  'src/features/forward/merged-forward-card.ts',
]);
const pureRoots = [
  'features/contacts/friend-request-input.ts',
  'features/groups/group-request-input.ts',
  'features/contacts/contact-operation-input.ts',
  'features/groups/group-operation-input.ts',
  'native/native-manifest.ts',
  'native/native-contracts.ts',
  'features/contacts/friend-categories.ts',
  'features/contacts/friend-category-input.ts',
  'features/messages/query-input.ts',
  'features/messages/recall-input.ts',
  'validation/identifiers.ts',
  'features/groups/group-essence-input.ts',
  'features/groups/files/group-file-input.ts',
  'features/groups/group-search-input.ts',
  'features/groups/group-avatar-input.ts',
  'features/groups/group-member-query-input.ts',
  'features/forward/forward-resource-input.ts',
  'features/forward/forward-resource-wire.ts',
  'features/media/download-input.ts',
  'features/forward/merged-forward-input.ts',
  'features/forward/forward-input.ts',
  'features/messages/send-input.ts',
  'features/messages/face-input.ts',
  'features/messages/inbound-elements.ts',
];
const pureBuiltins = new Set(['node:path', 'node:crypto', 'node:zlib', 'node:buffer', 'node:util']);

// Both ambient checks resolve symbols against the same configured source inventory.
const config = ts.readConfigFile(join(projectRoot, 'tsconfig.json'), ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot);
assert.deepEqual(parsed.errors, []);
const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
const checker = program.getTypeChecker();

test('ambient builtin loaders cannot bypass explicit dependency ownership', () => {
  for (const path of files) {
    const source = program.getSourceFile(path);
    assert.ok(source, `Missing source in ambient module analysis: ${label(path)}`);
    const references = findAmbientModuleLoadingReferences(source, checker);
    assert.deepEqual(
      references,
      [],
      `${label(path)}:${references[0]?.line}: use a reviewed explicit import instead of process.getBuiltinModule`,
    );
  }
});

test('ambient network acquisition requires an exact transport owner', () => {
  const observed = new Set<string>();
  for (const path of files) {
    const source = program.getSourceFile(path);
    assert.ok(source, `Missing source in ambient network analysis: ${label(path)}`);
    const references = findAmbientFetchReferences(source, checker);
    if (references.length === 0) continue;
    const owner = label(path);
    assert.ok(
      ambientNetworkOwners[owner],
      `${owner}:${references[0]!.line}: ambient fetch acquisition requires an exact transport owner`,
    );
    observed.add(owner);
  }
  for (const [owner, reason] of Object.entries(ambientNetworkOwners)) {
    assert.ok(reason.length > 0, `Missing ambient network ownership reason: ${owner}`);
    assert.ok(observed.has(owner), `Remove obsolete ambient network permission: ${owner}`);
  }
});

test('every source module uses exact reviewed external dependency ownership', () => {
  const observed = new Set<string>();
  for (const [path, edges] of graph)
    for (const edge of edges) {
      if (edge.target) continue;
      assert.equal(
        dependencyViolation({ from: label(path), to: edge.specifier, typeOnly: edge.typeOnly }),
        undefined,
        `${label(path)}:${edge.line} → ${edge.specifier}: unreviewed external dependency`,
      );
      observed.add(JSON.stringify([label(path), edge.specifier, edge.typeOnly]));
    }
  for (const [typeOnly, owners] of [
    [false, externalRuntimeDependencies],
    [true, externalTypeDependencies],
  ] as const)
    for (const [owner, specifiers] of Object.entries(owners))
      for (const specifier of specifiers)
        assert.ok(
          observed.has(JSON.stringify([owner, specifier, typeOnly])),
          `Remove obsolete external ownership: ${owner} → ${specifier} (typeOnly=${typeOnly})`,
        );
  for (const from of [
    'src/features/groups/new-action.ts',
    'src/runtime/new-owner.ts',
    'src/native/new-bundle.ts',
  ])
    for (const to of ['node:fs', 'node:module', 'silk-wasm'])
      for (const typeOnly of [false, true])
        assert.ok(dependencyViolation({ from, to, typeOnly }), `${from} inherited ${to}`);
  assert.ok(
    dependencyViolation({
      from: 'src/runtime/worker-termination.ts',
      to: 'node:child_process',
      typeOnly: false,
    }),
  );
});

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
