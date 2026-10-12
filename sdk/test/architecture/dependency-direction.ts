import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { extractSourceDependencies } from '../helpers/source-dependencies.ts';
import {
  crossFeatureDependencies,
  dependencyViolation,
  sourceOwnershipViolation,
} from '../helpers/dependency-policy.ts';
import {
  projectRoot,
  files,
  label,
  relativeTarget,
  graph,
  sourceFiles,
} from '../helpers/source-graph.ts';

test('source inventory rejects unreviewed files rather than omitting their dependencies', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'qq-source-inventory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'src');
  mkdirSync(source);
  const entry = join(source, 'entry.ts');
  const hidden = join(source, 'hidden.mts');
  writeFileSync(entry, "import './hidden.mts';\n");
  writeFileSync(hidden, 'export {};\n');
  // An imported module enters the compiler even though the root list contains only .ts.
  const program = ts.createProgram([entry], { noEmit: true, noLib: true });
  assert.ok(program.getSourceFile(hidden));
  assert.throws(() => sourceFiles(source), /Unreviewed source entry: .*hidden\.mts/);
  rmSync(hidden);
  writeFileSync(entry, 'export {};\n');
  mkdirSync(join(source, 'features'));
  writeFileSync(join(source, 'features', 'owner.ts'), 'export {};\n');
  assert.deepEqual(sourceFiles(source).sort(), [entry, join(source, 'features', 'owner.ts')]);
  for (const extension of ['cts', 'tsx', 'js', 'mjs', 'cjs', 'json', 'txt']) {
    const file = join(source, `unreviewed.${extension}`);
    writeFileSync(file, '');
    assert.throws(() => sourceFiles(source), /Unreviewed source entry:/);
    rmSync(file);
  }
});

test('source inventory rejects linked files and directories without traversing them', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'qq-source-links-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'src');
  const outside = join(directory, 'outside');
  mkdirSync(source);
  mkdirSync(outside);
  const externalFile = join(outside, 'owner.ts');
  writeFileSync(externalFile, 'export {};\n');
  // Windows junctions exercise directory links without requiring symlink privileges.
  const linkedDirectory = join(source, 'linked');
  symlinkSync(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => sourceFiles(source), /Unreviewed source entry: .*linked/);
  assert.throws(() => sourceFiles(linkedDirectory), /Unreviewed source entry: .*linked/);
  rmSync(linkedDirectory);
  if (process.platform !== 'win32') {
    symlinkSync(externalFile, join(source, 'linked.ts'));
    assert.throws(() => sourceFiles(source), /Unreviewed source entry: .*linked\.ts/);
  }
  assert.equal(readFileSync(externalFile, 'utf8'), 'export {};\n');
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
    ['src/features/groups/files/group-file-input.ts', 'src/features/messages/send-input.ts'],
    ['src/features/forward/merged-forward-input.ts', 'src/features/messages/send-input.ts'],
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
    ['src/native/new-bundle.ts', 'src/native/native-response.ts'],
    ['src/native/new-bundle.ts', 'src/runtime/cleanup.ts'],
    ['src/native/native-response.ts', 'src/native/native-package.ts'],
    ['src/native/native-response.ts', 'src/native/native-catalog.ts'],
    ['src/native/native-response.ts', 'src/storage/native-package-lock.ts'],
    ['src/native/native-response.ts', 'node:http'],
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

test('background task fatal observation has exact caller and primitive permissions', () => {
  const helper = 'src/runtime/background-task.ts';
  for (const from of [
    'src/worker.ts',
    'src/kernel.ts',
    'src/runtime/authentication-attempt.ts',
    'src/runtime/account-session-lifecycle.ts',
    'src/runtime/client-lifecycle.ts',
  ])
    assert.equal(dependencyViolation({ from, to: helper, typeOnly: false }), undefined);
  for (const from of [
    'src/native-services.ts',
    'src/client/qq-client.ts',
    'src/runtime/new-owner.ts',
    'src/features/groups/group-queries.ts',
    'src/errors.ts',
  ])
    for (const typeOnly of [false, true])
      assert.ok(dependencyViolation({ from, to: helper, typeOnly }));
  assert.equal(
    dependencyViolation({ from: helper, to: 'src/errors.ts', typeOnly: false }),
    undefined,
  );
  for (const to of ['node:fs', 'src/runtime/cleanup.ts', 'src/client/qq-client.ts'])
    for (const typeOnly of [false, true])
      assert.ok(dependencyViolation({ from: helper, to, typeOnly }));
  assert.ok(dependencyViolation({ from: helper, to: 'src/errors.ts', typeOnly: true }));
  assert.ok(
    dependencyViolation({
      from: 'src/kernel.ts',
      to: 'src/runtime/worker-task.ts',
      typeOnly: false,
    }),
  );
});
