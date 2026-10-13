import { externalDependencyViolation } from './external-dependencies.ts';

/** Architectural policy includes type edges: an erased import can still couple
 * ownership and force coordinated changes between otherwise independent modules.
 */
export interface SourceDependency {
  from: string;
  to: string;
  typeOnly: boolean;
}

const entryOwners = new Set([
  'src/index.ts',
  'src/types.ts',
  'src/errors.ts',
  'src/cli.ts',
  'src/worker.ts',
  'src/kernel.ts',
  'src/native-services.ts',
]);
const layers = new Set([
  'client',
  'cli',
  'contracts',
  'native',
  'runtime',
  'storage',
  'validation',
  'worker',
]);
const domains = new Set(['contacts', 'groups', 'messages', 'media', 'forward']);

/** Ownership is checked even for modules with no imports. A dependency-free
 * file must not silently establish another root or an unreviewed business domain.
 */
export function sourceOwnershipViolation(path: string): string | undefined {
  if (entryOwners.has(path)) return;
  const parts = path.split('/');
  if (parts[0] === 'src' && parts.length >= 3 && layers.has(parts[1]!)) return;
  if (parts[0] === 'src' && parts.length >= 4 && parts[1] === 'features' && domains.has(parts[2]!))
    return;
  return 'Source ownership is unclassified; assign its responsibility before adding the module.';
}

const primitives = new Set(['src/types.ts', 'src/errors.ts', 'src/validation/identifiers.ts']);
const isContract = (path: string) => path.startsWith('src/contracts/');
const contractDependencies: Record<string, readonly string[]> = {
  'src/contracts/client.ts': ['src/contracts/native.ts'],
  'src/contracts/events.ts': [
    'src/contracts/client.ts',
    'src/contracts/contacts.ts',
    'src/contracts/groups.ts',
    'src/contracts/messages.ts',
  ],
  'src/contracts/forward.ts': ['src/contracts/messages.ts'],
};
const workerDependencies = new Set([
  'src/worker/bootstrap.ts',
  'src/runtime/operations.ts',
  'src/runtime/worker-read-requests.ts',
  'src/runtime/background-task.ts',
]);
const bootstrapDependencies = new Set([
  'src/kernel.ts',
  'src/storage/data-directory-lock.ts',
  'src/features/media/record-codec-loader.ts',
  'src/features/media/video-codec-loader.ts',
  'src/features/media/builtin-record-codec.ts',
  'src/native/native-contract-inspection.ts',
  'src/worker/native-bootstrap.ts',
]);
const bootstrapTypeDependencies = new Set([
  'src/kernel.ts',
  'src/native/native-object.ts',
  'src/native/native-contracts.ts',
  'src/runtime/operations.ts',
  'src/runtime/media-contracts.ts',
]);
const kernelDependencies = new Set([
  'src/runtime/kernel-method.ts',
  'src/native-services.ts',
  'src/native/login-request.ts',
  'src/runtime/account-session-lifecycle.ts',
  'src/runtime/authentication-attempt.ts',
  'src/runtime/kernel-environment.ts',
  'src/runtime/cleanup.ts',
  'src/runtime/background-task.ts',
]);
const serviceRuntimeDependencies = new Set([
  'src/runtime/cleanup.ts',
  'src/runtime/native-service-lifetime.ts',
  'src/runtime/native-listener-owner.ts',
  'src/runtime/native-service-context.ts',
  'src/runtime/native-event-channel.ts',
  'src/runtime/operations.ts',
]);
// Exact composition permissions: runtime factories/ingress/history and separately reviewed context ports.
export const serviceFeatureRuntimeDependencies = [
  'src/features/contacts/friend-category-assignment.ts',
  'src/features/contacts/friend-category-mutations.ts',
  'src/features/groups/group-search.ts',
  'src/features/groups/files/group-files.ts',
  'src/features/groups/files/group-file-pages.ts',
  'src/features/messages/message-queries.ts',
  'src/features/contacts/friend-system-events.ts',
  'src/features/contacts/contact-directory.ts',
  'src/features/forward/forward-resource-owner.ts',
  'src/features/contacts/self-profile.ts',
  'src/features/groups/group-web-reads.ts',
  'src/features/groups/group-notices.ts',
  'src/features/forward/forward-messages.ts',
  'src/features/groups/group-requests.ts',
  'src/features/contacts/friend-requests.ts',
  'src/features/contacts/contact-operations.ts',
  'src/features/media/attachment-downloads.ts',
  'src/features/messages/message-resolution.ts',
  'src/features/messages/native-message-sender.ts',
  'src/features/groups/group-operations.ts',
  'src/features/groups/group-essence.ts',
  'src/features/groups/group-events.ts',
  'src/features/groups/group-queries.ts',
  'src/features/groups/group-system-events.ts',
  'src/features/messages/recall-events.ts',
  'src/features/messages/recall-operation.ts',
  'src/features/messages/incoming-message-delivery.ts',
] as const;
export const serviceFeatureTypeDependencies = [
  'src/features/contacts/friend-category-assignment.ts',
  'src/features/contacts/friend-category-mutations.ts',
  'src/features/groups/group-search.ts',
  'src/features/groups/files/group-files.ts',
  'src/features/messages/message-queries.ts',
  'src/features/contacts/contact-directory.ts',
  'src/features/forward/long-message-response.ts',
  'src/features/contacts/self-profile.ts',
  'src/features/groups/group-web-reads.ts',
  'src/features/groups/group-notices.ts',
  'src/features/forward/forward-messages.ts',
  'src/features/groups/group-requests.ts',
  'src/features/contacts/friend-requests.ts',
  'src/features/contacts/contact-operations.ts',
  'src/features/media/attachment-downloads.ts',
  'src/features/messages/message-resolution.ts',
  'src/features/messages/native-message-sender.ts',
  'src/features/groups/group-operations.ts',
  'src/features/groups/group-essence.ts',
  'src/features/groups/group-queries.ts',
  'src/features/messages/recall-operation.ts',
] as const;
const nativeContracts = new Set([
  'src/native/native-object.ts',
  'src/native/native-contracts.ts',
  'src/native/message-contracts.ts',
  'src/native/prepared-message-contracts.ts',
]);
const featurePorts = new Set([
  'src/runtime/media-contracts.ts',
  'src/runtime/native-event-channel.ts',
]);

const facadeInputs = new Set([
  'src/features/contacts/friend-request-input.ts',
  'src/features/groups/group-request-input.ts',
  'src/features/contacts/contact-operation-input.ts',
  'src/features/groups/group-operation-input.ts',
  'src/features/contacts/friend-category-input.ts',
  'src/features/forward/merged-forward-input.ts',
  'src/features/forward/forward-input.ts',
  'src/features/forward/forward-resource-input.ts',
  'src/features/messages/send-input.ts',
  'src/features/messages/query-input.ts',
  'src/features/messages/recall-input.ts',
  'src/features/messages/face-input.ts',
  'src/features/media/download-input.ts',
  'src/features/groups/group-essence-input.ts',
  'src/features/groups/files/group-file-input.ts',
  'src/features/groups/group-search-input.ts',
]);

// Cross-domain collaboration is reviewed at exact module pairs. A new feature
// does not gain permission to import an entire neighboring feature directory.
export const crossFeatureDependencies = [
  {
    from: 'src/features/groups/group-essence.ts',
    to: 'src/features/messages/message-query.ts',
    reason: 'Essence mutations resolve native sequence and random from an exact group message.',
  },
  {
    from: 'src/features/groups/group-essence-input.ts',
    to: 'src/features/messages/query-input.ts',
    reason: 'Essence actions resolve an exact message using pure query input capture.',
  },
  {
    from: 'src/features/media/download-input.ts',
    to: 'src/features/messages/query-input.ts',
    reason: 'Attachment queries share pure peer/history input capture.',
  },
  {
    from: 'src/features/messages/inbound-elements.ts',
    to: 'src/features/forward/received-forward.ts',
    reason: 'Received forward cards are projected as message elements.',
  },
  {
    from: 'src/features/messages/native-message-sender.ts',
    to: 'src/features/media/media-send.ts',
    reason: 'The single send receipt owner prepares video elements before dispatch.',
  },
  {
    from: 'src/features/messages/native-message-sender.ts',
    to: 'src/features/media/media-record.ts',
    reason: 'The single send receipt owner prepares voice elements before dispatch.',
  },
] as const;

export function dependencyViolation({ from, to, typeOnly }: SourceDependency): string | undefined {
  if (from === 'src/runtime/packet-transport.ts')
    return 'Packet transport owns byte request lifetime only; it cannot acquire domain, native loader or account implementations.';
  if (to === 'src/runtime/packet-transport.ts')
    return [
      'src/features/forward/long-message-response.ts',
      'src/features/forward/forward-resource-transport.ts',
    ].includes(from)
      ? undefined
      : 'Only the two reviewed forward byte adapters use the packet transport.';
  if (from === 'src/runtime/cleanup.ts')
    return 'Cleanup policy is a pure primitive; it cannot acquire resources or compose runtime owners.';
  if (
    [
      'src/storage/process-lock.ts',
      'src/storage/data-directory-lock.ts',
      'src/storage/native-package-lock.ts',
    ].includes(from) &&
    to === 'src/runtime/cleanup.ts'
  )
    return !typeOnly ? undefined : 'Lock owners use only the pure cleanup policy at runtime.';
  if (from === 'src/runtime/worker-task.ts' || to === 'src/runtime/worker-task.ts')
    return 'The retired worker-only task helper has no source permission.';
  if (from === 'src/runtime/background-task.ts')
    return !typeOnly && to === 'src/errors.ts'
      ? undefined
      : 'Background task observation only normalizes escaping failures through the error primitive.';
  if (to === 'src/runtime/background-task.ts')
    return [
      'src/worker.ts',
      'src/kernel.ts',
      'src/runtime/authentication-attempt.ts',
      'src/runtime/account-session-lifecycle.ts',
      'src/runtime/client-lifecycle.ts',
    ].includes(from)
      ? undefined
      : 'Fatal background task observation belongs only to the five reviewed execution owners.';
  if (from === 'src/runtime/feature-lifetime.ts')
    return 'Feature lifetime owns only local cancellation and an injected account wait port.';
  if (to === 'src/runtime/feature-lifetime.ts')
    return [
      'src/features/contacts/contact-directory.ts',
      'src/features/contacts/friend-requests.ts',
      'src/features/groups/files/group-files.ts',
      'src/features/groups/group-requests.ts',
    ].includes(from)
      ? undefined
      : 'Feature lifetime requires an exact reviewed local operation owner.';
  if (from === 'src/features/forward/forward-input.ts')
    return typeOnly && to === 'src/contracts/messages.ts'
      ? undefined
      : 'Existing-forward input owns only peer and ID capture, without execution or lifecycle dependencies.';
  if (from === 'src/features/forward/forward-resource-input.ts')
    return 'Forward-resource input has no dependencies; protocol decoding and resource acquisition belong to their owners.';
  if (from === 'src/features/contacts/friend-category-input.ts')
    return (!typeOnly && to === 'src/validation/identifiers.ts') ||
      (typeOnly && to === 'src/contracts/contacts.ts')
      ? undefined
      : 'Category input captures only public identifiers and ordered rows; query projection and mutation execution are separate owners.';
  if (from === 'src/features/contacts/friend-categories.ts')
    return (!typeOnly && to === 'src/errors.ts') || (typeOnly && to === 'src/contracts/contacts.ts')
      ? undefined
      : 'Category query projection only interprets native receipts into public DTOs; it cannot acquire input, lifecycle or native execution.';
  if (to === 'src/features/contacts/friend-categories.ts')
    return !typeOnly && from === 'src/features/contacts/contact-directory.ts'
      ? undefined
      : 'Only the contact directory projects a captured native category query; public input callers cannot acquire its result interpreter.';
  const domainInputContracts = {
    'src/features/contacts/friend-request-input.ts': 'src/contracts/contacts.ts',
    'src/features/groups/group-request-input.ts': 'src/contracts/groups.ts',
    'src/features/contacts/contact-operation-input.ts': 'src/contracts/contacts.ts',
    'src/features/groups/group-operation-input.ts': 'src/contracts/groups.ts',
  };
  if (Object.hasOwn(domainInputContracts, from))
    return typeOnly && to === domainInputContracts[from as keyof typeof domainInputContracts]
      ? undefined
      : 'Domain input modules only reference their domain data contracts; execution and resource dependencies are forbidden.';
  if (from === 'src/native-services.ts' && Object.hasOwn(domainInputContracts, to))
    return 'Domain input capture belongs to its domain owner; composition only routes payloads.';
  if (from === 'src/native-services.ts' && to === 'src/validation/identifiers.ts')
    return 'Group query input rules belong to the query owner; composition only routes payloads.';
  if (from === 'src/features/contacts/user-profile-query.ts')
    return typeOnly && to === 'src/contracts/contacts.ts'
      ? undefined
      : 'Profile query owns lookup and projection through injected ports, without acquisition or mutation dependencies.';
  if (to === 'src/features/contacts/user-profile-query.ts')
    return from === 'src/features/contacts/contact-operations.ts'
      ? undefined
      : 'Contact operation dispatch is the sole source caller of the resolved profile query.';
  if (to === 'src/features/groups/files/group-file-operations.ts')
    return 'The compatibility barrel preserves old consumers; source owners import their protocol directly.';
  if (from === 'src/features/groups/files/group-file-result.ts')
    return 'Group-file field capture cannot acquire protocol, lifecycle or resource implementations.';
  if (to === 'src/features/groups/files/group-file-result.ts')
    return [
      'src/features/groups/files/group-file-count.ts',
      'src/features/groups/files/group-folder-operations.ts',
      'src/features/groups/files/group-file-deletion.ts',
    ].includes(from)
      ? undefined
      : 'Group-file field capture belongs only to the reviewed count and folder protocols.';
  if (from === 'src/runtime/kernel-method.ts')
    return 'Kernel method capture has no resource or lifecycle dependencies; its caller supplies the active-owner check.';
  if (to === 'src/runtime/kernel-method.ts')
    return [
      'src/kernel.ts',
      'src/runtime/kernel-environment.ts',
      'src/runtime/account-session-lifecycle.ts',
    ].includes(from)
      ? undefined
      : 'Kernel method capture belongs only to preparation and account startup; business modules use their typed ports.';
  if (from === 'src/native/prepared-message-contracts.ts')
    return typeOnly && to === 'src/native/message-contracts.ts'
      ? undefined
      : 'Prepared outbound contracts only reference their reviewed native peer data type.';
  if (from === 'src/native/message-contracts.ts')
    return 'The constructed native peer descriptor owns only closed data declarations.';
  if (!to.startsWith('src/')) return externalDependencyViolation(from, to, typeOnly);
  if (to === 'src/features/contacts/friend-category-completion.ts')
    return [
      'src/features/contacts/friend-category-mutations.ts',
      'src/features/contacts/friend-category-assignment.ts',
    ].includes(from)
      ? undefined
      : 'Category ACK completion is private to its mutation owners.';
  if (from === 'src/features/contacts/friend-category-completion.ts')
    return to === 'src/errors.ts'
      ? undefined
      : 'Category ACK completion interprets receipts without acquiring native services or domain owners.';
  if (from === 'src/native/native-contracts.ts')
    return 'Native capability policy owns only measured profile data and pure matching rules.';
  if (from === 'src/native/native-contract-inspection.ts')
    return to === 'src/native/native-contracts.ts'
      ? undefined
      : 'Binary inspection only measures the selected file against the pure contract registry.';
  if (to === 'src/native/native-contract-inspection.ts' && from !== 'src/worker/bootstrap.ts')
    return 'Only the Node bootstrap may acquire measured binary provenance.';
  if (from === 'src/native/native-manifest.ts')
    return typeOnly && to === 'src/contracts/native.ts'
      ? undefined
      : 'Manifest preflight only owns pure metadata rules, never filesystem or source selection.';
  if (from === 'src/native/native-response.ts')
    return !typeOnly && to === 'src/runtime/cleanup.ts'
      ? undefined
      : 'Native response consumption owns only bounded bytes and cleanup, never transport or bundle policy.';
  if (to === 'src/native/native-response.ts')
    return !typeOnly &&
      ['src/native/native-catalog.ts', 'src/native/native-package.ts'].includes(from)
      ? undefined
      : 'Only catalog and package transports consume native HTTP responses.';
  if (from === 'src/native/native-directory-verification.ts')
    return (!typeOnly && to === 'src/native/native-manifest.ts') ||
      (typeOnly && to === 'src/contracts/native.ts')
      ? undefined
      : 'Directory verification only reads the selected inventory; it cannot select or install bundles.';
  if (
    to === 'src/native/native-directory-verification.ts' &&
    from !== 'src/native/native-package.ts'
  )
    return 'Only bundle preparation may request directory verification.';
  if (to === 'src/native/native-manifest.ts')
    return ['src/cli.ts', 'src/native/native-package.ts'].includes(from) && !typeOnly
      ? undefined
      : 'Manifest rules have exact reviewed input consumers.';
  if (from === 'src/native/native-bundle-installer.ts')
    return to === 'src/storage/native-package-lock.ts' ||
      (!typeOnly && to === 'src/runtime/cleanup.ts') ||
      (typeOnly && to === 'src/contracts/native.ts')
      ? undefined
      : 'The installer cannot depend on bundle source selection or account composition.';
  if (from === 'src/native/native-installed-storage.ts' && to === 'src/runtime/cleanup.ts')
    return !typeOnly
      ? undefined
      : 'Installed storage uses the pure cleanup policy without acquiring account runtime.';
  if (to === 'src/native/native-bundle-installer.ts' && from !== 'src/native/native-package.ts')
    return 'Only verified bundle preparation may dispatch an installation.';
  if (from === 'src/storage/native-package-lock.ts')
    return to === 'src/storage/process-lock.ts'
      ? undefined
      : 'Package locking uses the shared process-lock primitive, not bundle management.';
  if (from === 'src/client/client-event-presentation.ts')
    return typeOnly && to === 'src/contracts/native.ts'
      ? undefined
      : 'Client event presentation owns only delivery and shape audit; it cannot acquire lifecycle or native resources.';
  if (to === 'src/client/client-event-presentation.ts')
    return from === 'src/client/qq-client.ts' && !typeOnly
      ? undefined
      : 'Only the public client composes its event presentation owner.';
  if (from === 'src/types.ts')
    return typeOnly && isContract(to)
      ? undefined
      : 'The compatibility barrel only reexports public contract types.';
  if (isContract(from))
    return typeOnly && contractDependencies[from]?.includes(to)
      ? undefined
      : 'Contracts only depend on explicitly reviewed contract types.';
  if (to === 'src/types.ts')
    return from === 'src/index.ts' && typeOnly
      ? undefined
      : 'Internal modules import their contract domains instead of the compatibility barrel.';
  if (isContract(to))
    return typeOnly && from !== 'src/index.ts'
      ? undefined
      : 'Public contracts are type-only; the entry reexports them through the compatibility barrel.';
  if (primitives.has(from)) return 'Public primitives cannot depend on implementation.';
  if (primitives.has(to)) return;
  if (from === 'src/worker.ts')
    return workerDependencies.has(to)
      ? undefined
      : 'The worker owns IPC and delegates native acquisition to its bootstrap owner.';
  if (from === 'src/worker/bootstrap.ts')
    return bootstrapDependencies.has(to)
      ? undefined
      : 'The Node bootstrap binds only reviewed acquisition and kernel ports.';
  if (from === 'src/worker/native-bootstrap.ts')
    return to === 'src/runtime/cleanup.ts' || (typeOnly && bootstrapTypeDependencies.has(to))
      ? undefined
      : 'The worker owner uses injected acquisitions, not feature implementations or IO.';
  if (from === 'src/kernel.ts')
    return kernelDependencies.has(to) || (typeOnly && to === 'src/native/native-object.ts')
      ? undefined
      : 'Authentication composes its environment and account lifetime, not feature implementations.';
  if (from === 'src/native-services.ts') {
    if (to.startsWith('src/features/'))
      return (typeOnly ? serviceFeatureTypeDependencies : serviceFeatureRuntimeDependencies).some(
        (path) => path === to,
      )
        ? undefined
        : 'Service composition binds only reviewed domain factories, ingress, history and context ports.';
    return serviceRuntimeDependencies.has(to) ||
      to === 'src/native/native-contracts.ts' ||
      (typeOnly && nativeContracts.has(to))
      ? undefined
      : 'Service composition cannot acquire bundles, account directories or authentication owners.';
  }
  if (from === 'src/runtime/kernel-environment.ts')
    return to === 'src/runtime/kernel-method.ts' ||
      (typeOnly &&
        ['src/native/native-object.ts', 'src/runtime/account-session-lifecycle.ts'].includes(to))
      ? undefined
      : 'Environment preparation uses injected callbacks and does not interpret authentication state.';
  if (from.startsWith('src/storage/'))
    return to.startsWith('src/storage/') ? undefined : 'Storage cannot depend on higher layers.';
  if (from.startsWith('src/native/'))
    return to.startsWith('src/native/') || to.startsWith('src/storage/')
      ? undefined
      : 'Native bundle management cannot depend on account or business modules.';
  if (from.startsWith('src/runtime/'))
    return to.startsWith('src/runtime/') ||
      (typeOnly && nativeContracts.has(to)) ||
      (from === 'src/runtime/client-lifecycle.ts' && to === 'src/native/login-request.ts')
      ? undefined
      : 'Runtime cannot depend on feature implementations or entry points.';
  if (from.startsWith('src/features/')) {
    if (to === 'src/native/native-object.ts')
      return 'Features use unknown results and narrow ports, not proprietary dynamic objects.';
    if (typeOnly && (nativeContracts.has(to) || featurePorts.has(to))) return;
    // These owners preserve primary and cleanup failures for temporary listeners
    // or staging directories. The pure helper grants no runtime composition.
    if (
      [
        'src/features/contacts/self-profile.ts',
        'src/features/media/attachment-downloads.ts',
      ].includes(from) &&
      to === 'src/runtime/cleanup.ts'
    )
      return;
    if (to.startsWith('src/features/')) {
      if (from.split('/')[2] === to.split('/')[2]) return;
      if (crossFeatureDependencies.some((edge) => edge.from === from && edge.to === to)) return;
      return 'Cross-feature dependencies require an exact reviewed collaboration.';
    }
    return 'Features depend only on domain modules, primitives and typed ports.';
  }
  if (from === 'src/index.ts')
    return to === 'src/client/create-client.ts' ||
      to === 'src/client/qq-client.ts' ||
      (typeOnly && to === 'src/runtime/media-contracts.ts')
      ? undefined
      : 'The package entry only reexports its reviewed public interface.';
  if (from === 'src/client/qq-client.ts')
    return facadeInputs.has(to) ||
      to === 'src/client/client-event-presentation.ts' ||
      to === 'src/runtime/client-lifecycle.ts' ||
      (typeOnly && to === 'src/runtime/operation-contracts.ts')
      ? undefined
      : 'The facade cannot import native execution or feature operation implementations.';
  if (from === 'src/client/create-client.ts')
    return to === 'src/client/qq-client.ts' ||
      to === 'src/native/native-package.ts' ||
      to === 'src/native/login-request.ts'
      ? undefined
      : 'Client creation selects its native bundle and constructs the public facade.';
  if (from === 'src/cli/command-contracts.ts')
    return typeOnly && to === 'src/index.ts'
      ? undefined
      : 'CLI action contracts reference only the public client type.';
  if (from === 'src/cli/command-input.ts')
    return 'CLI flag parsing cannot depend on command composition or client acquisition.';
  if (from === 'src/cli/command-plan.ts')
    return to === 'src/cli/command-contracts.ts' ||
      to === 'src/cli/command-input.ts' ||
      to.startsWith('src/cli/commands/')
      ? undefined
      : 'Command composition only combines domain definitions and shared flag input.';
  if (from.startsWith('src/cli/commands/'))
    return to === 'src/cli/command-input.ts' ||
      (typeOnly && to === 'src/cli/command-contracts.ts') ||
      facadeInputs.has(to)
      ? undefined
      : 'Domain command plans use public actions and pure inputs, never entry/lifecycle composition.';
  if (from === 'src/cli.ts' || from.startsWith('src/cli/'))
    return to === 'src/index.ts' ||
      to.startsWith('src/cli/') ||
      facadeInputs.has(to) ||
      to === 'src/runtime/cleanup.ts' ||
      (from === 'src/cli.ts' && to === 'src/native/native-manifest.ts')
      ? undefined
      : 'CLI uses the public client, input capture and its own execution modules.';
  return 'Source ownership is unclassified; assign its layer before adding dependencies.';
}
