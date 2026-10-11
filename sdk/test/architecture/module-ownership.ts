import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { dynamicNativeOwners, dependencyViolation } from '../helpers/dependency-policy.ts';
import { projectRoot, graph } from '../helpers/source-graph.ts';

test('feature lifetime has no dependencies and only reviewed local owners can acquire it', () => {
  const lifetime = 'src/runtime/feature-lifetime.ts';
  assert.deepEqual(graph.get(join(projectRoot, lifetime)), []);
  for (const typeOnly of [false, true]) {
    for (const from of [
      'src/features/contacts/contact-directory.ts',
      'src/features/contacts/friend-requests.ts',
      'src/features/groups/group-files.ts',
      'src/features/groups/group-requests.ts',
    ])
      assert.equal(dependencyViolation({ from, to: lifetime, typeOnly }), undefined);
    for (const from of [
      'src/native-services.ts',
      'src/runtime/new-owner.ts',
      'src/client/qq-client.ts',
    ])
      assert.ok(dependencyViolation({ from, to: lifetime, typeOnly }));
    for (const to of [
      'src/runtime/native-service-lifetime.ts',
      'src/features/groups/group-files.ts',
      'node:fs',
    ])
      assert.ok(dependencyViolation({ from: lifetime, to, typeOnly }));
  }
});

test('group query composition cannot own identifier rules', () => {
  for (const typeOnly of [false, true]) {
    assert.ok(
      dependencyViolation({
        from: 'src/native-services.ts',
        to: 'src/validation/identifiers.ts',
        typeOnly,
      }),
    );
    assert.equal(
      dependencyViolation({
        from: 'src/features/groups/group-queries.ts',
        to: 'src/validation/identifiers.ts',
        typeOnly,
      }),
      undefined,
    );
  }
});

test('kernel method capture is private to preparation and account startup', () => {
  const capture = 'src/runtime/kernel-method.ts';
  assert.deepEqual(graph.get(join(projectRoot, capture)), []);
  for (const typeOnly of [false, true]) {
    for (const from of [
      'src/kernel.ts',
      'src/runtime/kernel-environment.ts',
      'src/runtime/account-session-lifecycle.ts',
    ])
      assert.equal(dependencyViolation({ from, to: capture, typeOnly }), undefined);
    for (const from of [
      'src/native-services.ts',
      'src/runtime/new-owner.ts',
      'src/features/groups/new-operation.ts',
      'src/client/qq-client.ts',
    ])
      assert.ok(dependencyViolation({ from, to: capture, typeOnly }));
    for (const to of ['src/runtime/account-session-lifecycle.ts', 'src/errors.ts', 'node:fs'])
      assert.ok(dependencyViolation({ from: capture, to, typeOnly }));
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

test('capability policy stays pure and only the Node bootstrap can acquire binary provenance', () => {
  const policy = 'src/native/native-contracts.ts';
  const inspection = 'src/native/native-contract-inspection.ts';
  for (const typeOnly of [false, true]) {
    for (const to of [
      'node:fs',
      'node:crypto',
      inspection,
      'src/native/native-package.ts',
      'src/storage/process-lock.ts',
    ])
      assert.ok(dependencyViolation({ from: policy, to, typeOnly }));
    for (const from of [
      'src/native-services.ts',
      'src/worker/native-bootstrap.ts',
      'src/native/new-source.ts',
      'src/runtime/account-session-lifecycle.ts',
      'src/features/contacts/friend-category-assignment.ts',
    ])
      assert.ok(dependencyViolation({ from, to: inspection, typeOnly }));
    assert.equal(dependencyViolation({ from: inspection, to: policy, typeOnly }), undefined);
    assert.ok(
      dependencyViolation({ from: inspection, to: 'src/native/native-package.ts', typeOnly }),
    );
  }
  assert.equal(
    dependencyViolation({ from: 'src/worker/bootstrap.ts', to: inspection, typeOnly: false }),
    undefined,
  );
  assert.ok(dependencyViolation({ from: 'src/worker/bootstrap.ts', to: policy, typeOnly: false }));
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

test('public forward-resource validation cannot acquire its protocol implementation', () => {
  const input = 'src/features/forward/forward-resource-input.ts';
  assert.deepEqual(graph.get(join(projectRoot, input)), []);
  for (const typeOnly of [false, true]) {
    for (const from of ['src/client/qq-client.ts', 'src/cli/commands/messages.ts']) {
      assert.equal(dependencyViolation({ from, to: input, typeOnly }), undefined);
      for (const to of [
        'src/features/forward/forward-resource-wire.ts',
        'src/features/forward/forward-resource-transport.ts',
      ])
        assert.ok(dependencyViolation({ from, to, typeOnly }));
    }
    for (const to of [
      'node:zlib',
      'src/features/forward/forward-resource-wire.ts',
      'src/native/native-object.ts',
    ])
      assert.ok(dependencyViolation({ from: input, to, typeOnly }));
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

test('management and request input owners stay pure while facade and CLI share their captures', () => {
  for (const [input, contract, command, operation] of [
    [
      'contacts/contact-operation-input.ts',
      'contacts.ts',
      'contacts.ts',
      'contacts/contact-operations.ts',
    ],
    ['groups/group-operation-input.ts', 'groups.ts', 'groups.ts', 'groups/group-operations.ts'],
    [
      'contacts/friend-request-input.ts',
      'contacts.ts',
      'contacts.ts',
      'contacts/friend-requests.ts',
    ],
    ['groups/group-request-input.ts', 'groups.ts', 'groups.ts', 'groups/group-requests.ts'],
  ]) {
    const to = `src/features/${input}`;
    assert.equal(
      dependencyViolation({ from: to, to: `src/contracts/${contract}`, typeOnly: true }),
      undefined,
    );
    for (const typeOnly of [false, true]) {
      assert.ok(dependencyViolation({ from: 'src/native-services.ts', to, typeOnly }));
      assert.ok(dependencyViolation({ from: to, to: `src/features/${operation}`, typeOnly }));
      assert.ok(
        dependencyViolation({ from: to, to: 'src/runtime/native-event-channel.ts', typeOnly }),
      );
      assert.equal(
        dependencyViolation({ from: 'src/client/qq-client.ts', to, typeOnly }),
        undefined,
      );
      assert.equal(
        dependencyViolation({ from: `src/cli/commands/${command}`, to, typeOnly }),
        undefined,
      );
    }
    assert.ok(dependencyViolation({ from: to, to: `src/contracts/${contract}`, typeOnly: false }));
  }
});
