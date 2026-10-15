import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { dependencyViolation } from '../helpers/dependency-policy.ts';
import { projectRoot, graph } from '../helpers/source-graph.ts';

test('packet lifetime stays behind the two reviewed protocol adapters', () => {
  const transport = 'src/runtime/packet-transport.ts';
  for (const from of [
    'src/features/forward/long-message-response.ts',
    'src/features/forward/forward-resource-transport.ts',
  ])
    for (const typeOnly of [false, true])
      assert.equal(dependencyViolation({ from, to: transport, typeOnly }), undefined);
  for (const from of [
    'src/client/qq-client.ts',
    'src/native-services.ts',
    'src/features/forward/forward-resource-input.ts',
    'src/features/groups/new-packet-action.ts',
  ])
    for (const typeOnly of [false, true])
      assert.ok(dependencyViolation({ from, to: transport, typeOnly }));
  for (const to of [
    'src/native/native-object.ts',
    'src/features/forward/forward-resource-wire.ts',
    'src/runtime/account-session-lifecycle.ts',
    'node:net',
  ])
    for (const typeOnly of [false, true])
      assert.ok(dependencyViolation({ from: transport, to, typeOnly }));
});

test('lock owners share only the pure cleanup primitive without acquiring runtime owners', () => {
  for (const from of [
    'src/storage/process-lock.ts',
    'src/storage/data-directory-lock.ts',
    'src/storage/native-package-lock.ts',
  ]) {
    assert.equal(
      dependencyViolation({ from, to: 'src/runtime/cleanup.ts', typeOnly: false }),
      undefined,
    );
    for (const to of ['src/runtime/client-lifecycle.ts', 'src/runtime/native-service-lifetime.ts'])
      assert.ok(dependencyViolation({ from, to, typeOnly: false }));
  }
  for (const to of [
    'src/errors.ts',
    'src/storage/process-lock.ts',
    'src/runtime/client-lifecycle.ts',
    'node:fs',
  ])
    for (const typeOnly of [false, true])
      assert.ok(dependencyViolation({ from: 'src/runtime/cleanup.ts', to, typeOnly }));
  assert.ok(
    dependencyViolation({
      from: 'src/storage/unreviewed-lock.ts',
      to: 'src/runtime/cleanup.ts',
      typeOnly: false,
    }),
  );
});

test('category input callers cannot acquire query projection or mutation execution', () => {
  const input = 'src/features/contacts/friend-category-input.ts';
  const projection = 'src/features/contacts/friend-categories.ts';
  const callers = [
    'src/client/qq-client.ts',
    'src/cli/commands/contacts.ts',
    'src/features/contacts/friend-category-create.ts',
    'src/features/contacts/friend-category-mutations.ts',
    'src/features/contacts/friend-category-assignment.ts',
  ];
  for (const from of callers) {
    assert.ok(
      graph
        .get(join(projectRoot, from))!
        .some((edge) => !edge.typeOnly && edge.target === join(projectRoot, input)),
      `${from} must use the shared input owner directly`,
    );
    for (const typeOnly of [false, true]) {
      assert.equal(dependencyViolation({ from, to: input, typeOnly }), undefined);
      assert.ok(dependencyViolation({ from, to: projection, typeOnly }));
    }
  }
  assert.equal(
    dependencyViolation({
      from: 'src/features/contacts/contact-directory.ts',
      to: projection,
      typeOnly: false,
    }),
    undefined,
  );
  for (const from of [input, projection])
    for (const to of [
      from === input ? projection : input,
      'src/features/contacts/friend-category-mutations.ts',
      'src/features/contacts/contact-directory.ts',
      'src/runtime/native-service-lifetime.ts',
      'src/native/native-object.ts',
      'node:fs',
    ])
      for (const typeOnly of [false, true])
        assert.ok(dependencyViolation({ from, to, typeOnly }), `${from} acquired ${to}`);
});

test('group-file field capture stays private to count and folder protocols', () => {
  const reader = 'src/features/groups/files/group-file-result.ts';
  assert.deepEqual(graph.get(join(projectRoot, reader)), []);
  for (const typeOnly of [false, true]) {
    for (const from of [
      'src/features/groups/files/group-file-count.ts',
      'src/features/groups/files/group-folder-operations.ts',
    ])
      assert.equal(dependencyViolation({ from, to: reader, typeOnly }), undefined);
    for (const from of [
      'src/native-services.ts',
      'src/features/groups/files/group-files.ts',
      'src/features/groups/new-action.ts',
      'src/client/qq-client.ts',
    ])
      assert.ok(dependencyViolation({ from, to: reader, typeOnly }));
    for (const to of ['node:fs', 'src/runtime/feature-lifetime.ts', 'src/errors.ts'])
      assert.ok(dependencyViolation({ from: reader, to, typeOnly }));
    for (const from of [
      'src/features/groups/files/group-files.ts',
      'src/features/groups/new-action.ts',
      'src/native-services.ts',
    ])
      assert.ok(
        dependencyViolation({
          from,
          to: 'src/features/groups/files/group-file-operations.ts',
          typeOnly,
        }),
      );
  }
});

test('feature lifetime has no dependencies and only reviewed local owners can acquire it', () => {
  const lifetime = 'src/runtime/feature-lifetime.ts';
  assert.deepEqual(graph.get(join(projectRoot, lifetime)), []);
  for (const typeOnly of [false, true]) {
    for (const from of [
      'src/features/contacts/contact-directory.ts',
      'src/features/contacts/friend-requests.ts',
      'src/features/groups/files/group-files.ts',
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
      'src/features/groups/files/group-files.ts',
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

test('domain modules cannot acquire the proprietary dynamic native object', () => {
  const to = 'src/native/native-object.ts';
  for (const from of [
    'src/features/groups/new-input.ts',
    'src/features/messages/new-projector.ts',
    'src/features/contacts/new-operation.ts',
    'src/features/groups/files/group-files.ts',
    'src/features/messages/native-message-sender.ts',
    'src/features/messages/message-resolution.ts',
    'src/features/messages/incoming-message-delivery.ts',
    'src/features/messages/inbound-messages.ts',
    'src/features/messages/inbound-mentions.ts',
    'src/features/messages/inbound-elements.ts',
    'src/features/contacts/contact-directory.ts',
    'src/features/contacts/friend-categories.ts',
    'src/features/contacts/friend-category-mutations.ts',
    'src/features/contacts/friend-requests.ts',
    'src/features/groups/group-queries.ts',
    'src/features/messages/send-input.ts',
  ])
    for (const typeOnly of [false, true])
      assert.ok(dependencyViolation({ from, to, typeOnly }), `${from} inherited ${to}`);
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
    'src/features/groups/files/group-files.ts',
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

test('resolved profile query has a single dispatcher and only its public DTO dependency', () => {
  const query = 'src/features/contacts/user-profile-query.ts';
  const edges = graph.get(join(projectRoot, query))!;
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.typeOnly, true);
  assert.equal(edges[0]!.target, join(projectRoot, 'src/contracts/contacts.ts'));
  for (const typeOnly of [false, true]) {
    assert.equal(
      dependencyViolation({
        from: 'src/features/contacts/contact-operations.ts',
        to: query,
        typeOnly,
      }),
      undefined,
    );
    for (const from of [
      'src/native-services.ts',
      'src/features/contacts/new-action.ts',
      'src/client/qq-client.ts',
    ])
      assert.ok(dependencyViolation({ from, to: query, typeOnly }));
    for (const to of [
      'node:fs',
      'src/runtime/feature-lifetime.ts',
      'src/features/contacts/contact-directory.ts',
      'src/features/contacts/contact-operations.ts',
    ])
      assert.ok(dependencyViolation({ from: query, to, typeOnly }));
  }
  assert.ok(dependencyViolation({ from: query, to: 'src/contracts/contacts.ts', typeOnly: false }));
});

test('client event presentation has one composer and no lifecycle, native or IO dependencies', () => {
  const presentation = 'src/client/client-event-presentation.ts';
  const edges = graph.get(join(projectRoot, presentation))!;
  assert.deepEqual(
    edges.map(({ target, typeOnly }) => ({ target, typeOnly })),
    ['src/contracts/native.ts', 'src/client/events.ts'].map((owner) => ({
      target: join(projectRoot, owner),
      typeOnly: true,
    })),
  );
  assert.equal(
    dependencyViolation({ from: 'src/client/qq-client.ts', to: presentation, typeOnly: false }),
    undefined,
  );
  for (const typeOnly of [false, true]) {
    for (const from of [
      'src/client/create-client.ts',
      'src/runtime/client-lifecycle.ts',
      'src/native-services.ts',
      'src/features/messages/recall-events.ts',
      'src/client/new-owner.ts',
    ])
      assert.ok(dependencyViolation({ from, to: presentation, typeOnly }));
    for (const to of [
      'src/runtime/client-lifecycle.ts',
      'src/runtime/worker-rpc-channel.ts',
      'src/native/native-object.ts',
      'src/native/native-package.ts',
      'src/client/qq-client.ts',
      'src/contracts/diagnostics.ts',
      'node:fs',
    ])
      assert.ok(dependencyViolation({ from: presentation, to, typeOnly }));
  }
  assert.ok(
    dependencyViolation({ from: presentation, to: 'src/contracts/native.ts', typeOnly: false }),
  );
});

test('message event replies have one client binder and only captured input dependencies', () => {
  const owner = 'src/client/message-event.ts';
  assert.deepEqual(
    graph.get(join(projectRoot, owner))!.map(({ target, typeOnly }) => ({ target, typeOnly })),
    [
      { target: join(projectRoot, 'src/contracts/messages.ts'), typeOnly: true },
      { target: join(projectRoot, 'src/client/events.ts'), typeOnly: true },
      { target: join(projectRoot, 'src/features/messages/send-input.ts'), typeOnly: false },
      { target: join(projectRoot, 'src/client/contacts/contact-context.ts'), typeOnly: true },
      ...['friend-contact', 'group-contact', 'group-member-contact'].map((name) => ({
        target: join(projectRoot, `src/client/contacts/${name}.ts`),
        typeOnly: false,
      })),
    ],
  );
  assert.equal(
    dependencyViolation({ from: 'src/client/qq-client.ts', to: owner, typeOnly: false }),
    undefined,
  );
  for (const typeOnly of [false, true]) {
    for (const from of [
      'src/client/create-client.ts',
      'src/client/client-event-presentation.ts',
      'src/runtime/client-lifecycle.ts',
      'src/native-services.ts',
      'src/features/messages/message-query.ts',
      'src/client/new-owner.ts',
    ])
      assert.ok(dependencyViolation({ from, to: owner, typeOnly }));
    for (const to of [
      'src/client/qq-client.ts',
      'src/runtime/client-lifecycle.ts',
      'src/runtime/worker-rpc-channel.ts',
      'src/native/native-object.ts',
      'node:fs',
      'src/features/messages/existing-native-message-sender.ts',
    ])
      assert.ok(dependencyViolation({ from: owner, to, typeOnly }));
  }
  assert.ok(dependencyViolation({ from: owner, to: 'src/contracts/messages.ts', typeOnly: false }));
  assert.ok(
    dependencyViolation({ from: owner, to: 'src/features/messages/send-input.ts', typeOnly: true }),
  );
});
