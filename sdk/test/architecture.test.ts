import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { getFileInfo } from 'prettier';
import { extractSourceDependencies } from './helpers/source-dependencies.ts';
import { findAmbientFetchReferences } from './helpers/ambient-network.ts';
import {
  crossFeatureDependencies,
  dynamicNativeOwners,
  dependencyViolation,
  sourceOwnershipViolation,
} from './helpers/dependency-policy.ts';
import {
  externalRuntimeDependencies,
  externalTypeDependencies,
  ambientNetworkOwners,
} from './helpers/external-dependencies.ts';

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

test('ambient network acquisition requires an exact transport owner', () => {
  const config = ts.readConfigFile(join(projectRoot, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot);
  assert.deepEqual(parsed.errors, []);
  const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
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

test('domain CLI plans cannot depend back on entry, registry or client acquisition', () => {
  for (const from of [
    'src/cli/commands/contacts.ts',
    'src/cli/commands/groups.ts',
    'src/cli/commands/messages.ts',
    'src/cli/command-input.ts',
  ]) {
    for (const to of [
      'src/cli.ts',
      'src/cli/command-plan.ts',
      'src/cli/client-command.ts',
      'src/client/create-client.ts',
      'src/native/native-package.ts',
    ]) {
      for (const typeOnly of [false, true])
        assert.ok(dependencyViolation({ from, to, typeOnly }), `${from} must not import ${to}`);
    }
  }
});

test('service composition delegates message-update ingress without projecting recall records', () => {
  const source = ts.createSourceFile(
    'native-services.ts',
    readFileSync(join(sourceRoot, 'native-services.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const hooks: ts.PropertyAssignment[] = [];
  const imported: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'onMsgInfoListUpdate')
      hooks.push(node);
    if (ts.isImportSpecifier(node)) imported.push((node.propertyName ?? node.name).text);
    assert.ok(
      !ts.isPropertyAccessExpression(node) || node.name.text !== 'recallTime',
      'Recall metadata interpretation belongs to the message-update event owner.',
    );
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(hooks.length, 1);
  const hook = hooks[0]!.initializer;
  assert.ok(ts.isPropertyAccessExpression(hook), 'Composition must wire the owned callback.');
  assert.equal(hook.name.text, 'onMessageUpdates');
  assert.ok(imported.includes('createMessageUpdateEvents'));
  assert.ok(!imported.includes('createRecallEvents'));
});

test('manifest preflight and directory verification cannot acquire source selection or installation', () => {
  for (const from of [
    'src/native/native-manifest.ts',
    'src/native/native-directory-verification.ts',
  ]) {
    for (const to of [
      'src/native/native-package.ts',
      'src/native/native-catalog.ts',
      'src/native/native-bundle-installer.ts',
      'src/native/native-installed-storage.ts',
      'src/storage/native-package-lock.ts',
    ])
      for (const typeOnly of [false, true]) assert.ok(dependencyViolation({ from, to, typeOnly }));
  }
  for (const typeOnly of [false, true]) {
    assert.ok(
      dependencyViolation({
        from: 'src/native/native-manifest.ts',
        to: 'src/native/native-directory-verification.ts',
        typeOnly,
      }),
    );
    assert.ok(
      dependencyViolation({
        from: 'src/native/new-source.ts',
        to: 'src/native/native-directory-verification.ts',
        typeOnly,
      }),
    );
    assert.ok(
      dependencyViolation({ from: 'src/cli.ts', to: 'src/native/native-package.ts', typeOnly }),
    );
  }
});

test('every source module has a reviewed owner even when it has no dependencies', () => {
  for (const path of files)
    assert.equal(sourceOwnershipViolation(label(path)), undefined, label(path));
  for (const path of ['src/utils.ts', 'src/common/tool.ts', 'src/features/misc/operation.ts'])
    assert.ok(sourceOwnershipViolation(path), `${path} bypassed ownership with no imports`);
});

test('import-equals dependencies participate in direction and cycle analysis', () => {
  for (const typeOnly of [false, true]) {
    const from = 'src/features/groups/new-action.ts';
    const source = `import ${typeOnly ? 'type ' : ''}Facade = require('../../client/qq-client.ts');`;
    const result = extractSourceDependencies(from, source);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.dependencies, [
      { specifier: '../../client/qq-client.ts', typeOnly, line: 1 },
    ]);
    const target = relativeTarget(join(projectRoot, from), result.dependencies[0]!.specifier);
    assert.ok(target);
    assert.ok(dependencyViolation({ from, to: label(target), typeOnly }));
  }
});

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
    ['src/features/forward/forward-messages.ts', 'src/runtime/native-service-context.ts'],
    ['src/features/forward/forward-messages.ts', 'src/runtime/account-session-lifecycle.ts'],
    ['src/features/groups/qun-web-read.ts', 'src/runtime/native-service-context.ts'],
    ['src/features/groups/web-group-notices.ts', 'src/runtime/native-service-context.ts'],
    ['src/features/groups/group-web-reads.ts', 'src/runtime/native-service-context.ts'],
    ['src/features/groups/group-web-reads.ts', 'src/runtime/native-service-lifetime.ts'],
    ['src/features/contacts/new-profile.ts', 'src/runtime/cleanup.ts'],
    ['src/features/media/new-download.ts', 'src/runtime/cleanup.ts'],
    ['src/features/media/attachment-downloads.ts', 'src/runtime/native-service-context.ts'],
    ['src/features/media/attachment-downloads.ts', 'src/runtime/account-session-lifecycle.ts'],
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
    ['src/worker.ts', 'src/kernel.ts'],
    ['src/worker.ts', 'src/storage/data-directory-lock.ts'],
    ['src/worker.ts', 'src/native/native-contracts.ts'],
    ['src/worker.ts', 'src/features/media/record-codec-loader.ts'],
    ['src/worker/native-bootstrap.ts', 'src/features/media/record-codec-loader.ts'],
    ['src/worker/native-bootstrap.ts', 'src/storage/data-directory-lock.ts'],
    ['src/worker/native-bootstrap.ts', 'node:fs/promises'],
    ['src/worker/new-owner.ts', 'src/kernel.ts'],
    ['src/worker/new-owner.ts', 'src/worker/bootstrap.ts'],
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

test('native composition delegates forward resource orchestration to its domain owner', () => {
  const from = 'src/native-services.ts';
  for (const to of [
    'src/features/forward/merged-forward.ts',
    'src/features/forward/merged-forward-input.ts',
    'src/features/forward/forward-resource-transport.ts',
    'src/features/forward/forward-resource-wire.ts',
    'src/features/forward/new-resource.ts',
  ])
    for (const typeOnly of [false, true])
      assert.ok(dependencyViolation({ from, to, typeOnly }), `${from} inherited ${to}`);
  assert.ok(
    dependencyViolation({
      from,
      to: 'src/features/forward/long-message-response.ts',
      typeOnly: false,
    }),
  );
  assert.equal(
    dependencyViolation({
      from,
      to: 'src/features/forward/long-message-response.ts',
      typeOnly: true,
    }),
    undefined,
  );
});

test('group-file composition cannot regain operation policy through input or adapter imports', () => {
  for (const typeOnly of [false, true]) {
    for (const to of [
      'src/features/groups/group-file-input.ts',
      'src/features/groups/group-file-operations.ts',
      'src/features/groups/group-file-page-codec.ts',
    ])
      assert.ok(dependencyViolation({ from: 'src/native-services.ts', to, typeOnly }));
    assert.equal(
      dependencyViolation({
        from: 'src/native-services.ts',
        to: 'src/features/groups/group-files.ts',
        typeOnly,
      }),
      undefined,
    );
  }
});

test('category composition cannot regain input or creation completion policy', () => {
  for (const typeOnly of [false, true]) {
    for (const to of [
      'src/features/contacts/friend-categories.ts',
      'src/features/contacts/friend-category-create.ts',
      'src/features/contacts/friend-category-completion.ts',
    ])
      assert.ok(dependencyViolation({ from: 'src/native-services.ts', to, typeOnly }));
    assert.equal(
      dependencyViolation({
        from: 'src/native-services.ts',
        to: 'src/features/contacts/friend-category-mutations.ts',
        typeOnly,
      }),
      undefined,
    );
  }
});

test('dynamic native object permissions apply only to actual reviewed adapters and projectors', () => {
  const to = 'src/native/native-object.ts';
  for (const from of [
    'src/features/groups/new-input.ts',
    'src/features/messages/new-projector.ts',
    'src/features/contacts/new-operation.ts',
    'src/features/groups/group-files.ts',
    'src/features/messages/native-message-sender.ts',
    'src/features/messages/message-resolution.ts',
    'src/features/messages/incoming-message-delivery.ts',
    'src/features/messages/inbound-messages.ts',
    'src/features/messages/inbound-mentions.ts',
    'src/features/contacts/contact-directory.ts',
    'src/features/contacts/friend-categories.ts',
    'src/features/contacts/friend-category-mutations.ts',
    'src/features/contacts/friend-requests.ts',
    'src/features/groups/group-queries.ts',
    'src/features/messages/send-input.ts',
  ])
    for (const typeOnly of [false, true])
      assert.ok(dependencyViolation({ from, to, typeOnly }), `${from} inherited ${to}`);
  for (const [from, reason] of Object.entries(dynamicNativeOwners)) {
    assert.ok(reason.length > 0, `Missing dynamic object ownership reason: ${from}`);
    assert.ok(
      graph.get(join(projectRoot, from))?.some((edge) => edge.target === join(projectRoot, to)),
      `Remove obsolete dynamic object permission: ${from}`,
    );
    assert.equal(dependencyViolation({ from, to, typeOnly: true }), undefined);
    assert.ok(dependencyViolation({ from, to, typeOnly: false }));
  }
});

test('message composition delegates projection and identity orchestration to its domain owner', () => {
  for (const typeOnly of [false, true]) {
    for (const to of [
      'src/features/messages/inbound-elements.ts',
      'src/features/messages/inbound-messages.ts',
      'src/features/messages/inbound-mentions.ts',
    ])
      assert.ok(dependencyViolation({ from: 'src/native-services.ts', to, typeOnly }));
    assert.equal(
      dependencyViolation({
        from: 'src/native-services.ts',
        to: 'src/features/messages/message-resolution.ts',
        typeOnly,
      }),
      undefined,
    );
  }
});

test('search composition binds its domain owner without importing input policy', () => {
  for (const typeOnly of [false, true]) {
    assert.ok(
      dependencyViolation({
        from: 'src/native-services.ts',
        to: 'src/features/groups/group-search-input.ts',
        typeOnly,
      }),
    );
    assert.equal(
      dependencyViolation({
        from: 'src/native-services.ts',
        to: 'src/features/groups/group-search.ts',
        typeOnly,
      }),
      undefined,
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
  'src/native/native-manifest.ts',
  'src/types.ts',
  'src/errors.ts',
  'src/validation/identifiers.ts',
  'src/features/contacts/friend-categories.ts',
  'src/features/messages/query-input.ts',
  'src/features/groups/group-essence-input.ts',
  'src/features/groups/group-file-input.ts',
  'src/features/groups/group-search-input.ts',
  'src/features/media/download-input.ts',
  'src/features/forward/merged-forward-input.ts',
  'src/features/messages/send-input.ts',
  'src/features/messages/face-input.ts',
  'src/features/messages/inbound-elements.ts',
  'src/features/forward/received-forward.ts',
  'src/features/messages/qq-faces.ts',
  'src/features/forward/long-message-request.ts',
  'src/features/forward/forward-resource-wire.ts',
  'src/features/forward/merged-forward-card.ts',
]);
const pureRoots = [
  'native/native-manifest.ts',
  'features/contacts/friend-categories.ts',
  'features/messages/query-input.ts',
  'validation/identifiers.ts',
  'features/groups/group-essence-input.ts',
  'features/groups/group-file-input.ts',
  'features/groups/group-search-input.ts',
  'features/forward/forward-resource-wire.ts',
  'features/media/download-input.ts',
  'features/forward/merged-forward-input.ts',
  'features/messages/send-input.ts',
  'features/messages/face-input.ts',
  'features/messages/inbound-elements.ts',
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

test('all relative source dependencies have no cycles, including erased type imports', () => {
  const complete = new Set<string>();
  const active: string[] = [];
  function walk(path: string) {
    const index = active.indexOf(path);
    assert.equal(
      index,
      -1,
      `Source dependency cycle: ${[...active.slice(index < 0 ? 0 : index), path].map(label).join(' → ')}`,
    );
    if (complete.has(path)) return;
    active.push(path);
    for (const edge of graph.get(path)!) if (edge.target) walk(edge.target);
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

test('typed query, download and prepared element owners cannot regain the native object escape hatch', () => {
  for (const from of [
    'src/features/messages/message-query.ts',
    'src/features/messages/message-queries.ts',
    'src/features/media/attachment-downloads.ts',
    'src/features/messages/face-input.ts',
    'src/features/messages/outbound-elements.ts',
    'src/features/media/media-record.ts',
    'src/features/media/media-send.ts',
    'src/features/groups/group-files.ts',
  ])
    assert.ok(dependencyViolation({ from, to: 'src/native/native-object.ts', typeOnly: true }));
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

test('category completion has exact callers and cannot regain native or identity ownership', () => {
  const completion = 'src/features/contacts/friend-category-completion.ts';
  for (const typeOnly of [false, true]) {
    for (const from of [
      'src/features/contacts/friend-categories.ts',
      'src/features/contacts/contact-directory.ts',
      'src/features/contacts/new-operation.ts',
      'src/client/qq-client.ts',
      'src/cli/commands/contacts.ts',
      'src/native-services.ts',
    ])
      assert.ok(dependencyViolation({ from, to: completion, typeOnly }));
    for (const from of [
      'src/features/contacts/friend-category-mutations.ts',
      'src/features/contacts/friend-category-assignment.ts',
    ])
      assert.equal(dependencyViolation({ from, to: completion, typeOnly }), undefined);
    for (const to of [
      'src/features/contacts/contact-directory.ts',
      'src/native/native-object.ts',
      'src/native/native-contracts.ts',
      'src/runtime/native-service-lifetime.ts',
    ])
      assert.ok(dependencyViolation({ from: completion, to, typeOnly }));
  }
});

test('ordinary send composition binds its owner without capturing input or resolving recipients', () => {
  for (const typeOnly of [false, true]) {
    assert.ok(
      dependencyViolation({
        from: 'src/native-services.ts',
        to: 'src/features/messages/send-input.ts',
        typeOnly,
      }),
    );
    assert.equal(
      dependencyViolation({
        from: 'src/native-services.ts',
        to: 'src/features/messages/native-message-sender.ts',
        typeOnly,
      }),
      undefined,
    );
  }
});

test('attachment composition delegates input and peer conversion to its download owner', () => {
  for (const typeOnly of [false, true]) {
    assert.ok(
      dependencyViolation({
        from: 'src/native-services.ts',
        to: 'src/features/media/download-input.ts',
        typeOnly,
      }),
    );
    assert.equal(
      dependencyViolation({
        from: 'src/native-services.ts',
        to: 'src/features/media/attachment-downloads.ts',
        typeOnly,
      }),
      undefined,
    );
  }
});

test('attachment staging can preserve cleanup failures without acquiring runtime composition', () => {
  assert.equal(
    dependencyViolation({
      from: 'src/features/media/attachment-downloads.ts',
      to: 'src/runtime/cleanup.ts',
      typeOnly: false,
    }),
    undefined,
  );
});

test('recall composition delegates input capture and recipient orchestration to its domain owner', () => {
  for (const typeOnly of [false, true]) {
    assert.ok(
      dependencyViolation({
        from: 'src/native-services.ts',
        to: 'src/features/messages/recall-input.ts',
        typeOnly,
      }),
    );
    assert.equal(
      dependencyViolation({
        from: 'src/native-services.ts',
        to: 'src/features/messages/recall-operation.ts',
        typeOnly,
      }),
      undefined,
    );
    assert.ok(
      dependencyViolation({
        from: 'src/features/messages/recall-operation.ts',
        to: 'src/runtime/native-service-context.ts',
        typeOnly,
      }),
    );
  }
});
