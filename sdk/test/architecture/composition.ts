import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { dependencyViolation } from '../helpers/dependency-policy.ts';
import { projectRoot, sourceRoot, label, runtimeEdges } from '../helpers/source-graph.ts';

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

test('public input runtime closures cannot load forward-resource response decoding or transport', () => {
  const privateImplementations = new Set([
    'src/features/forward/forward-resource-wire.ts',
    'src/features/forward/forward-resource-transport.ts',
  ]);
  for (const root of ['src/client/qq-client.ts', 'src/cli/commands/messages.ts']) {
    const visited = new Set<string>();
    function walk(path: string, trail: string[]): void {
      if (visited.has(path)) return;
      visited.add(path);
      assert.ok(!privateImplementations.has(label(path)), trail.join(' → '));
      for (const edge of runtimeEdges(path))
        if (edge.target) walk(edge.target, [...trail, label(edge.target)]);
    }
    walk(join(projectRoot, root), [root]);
  }
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
      'src/features/groups/group-file-count.ts',
      'src/features/groups/group-folder-operations.ts',
      'src/features/groups/group-file-result.ts',
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
