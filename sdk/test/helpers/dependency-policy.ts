/** Architectural policy includes type edges: an erased import can still couple
 * ownership and force coordinated changes between otherwise independent modules.
 */
export interface SourceDependency {
  from: string;
  to: string;
  typeOnly: boolean;
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
  'src/kernel.ts',
  'src/runtime/operations.ts',
  'src/runtime/worker-read-requests.ts',
  'src/storage/data-directory-lock.ts',
  'src/features/media/record-codec-loader.ts',
  'src/features/media/video-codec-loader.ts',
  'src/features/media/builtin-record-codec.ts',
  'src/native/native-contracts.ts',
]);
const kernelDependencies = new Set([
  'src/native-services.ts',
  'src/native/login-request.ts',
  'src/runtime/account-session-lifecycle.ts',
  'src/runtime/kernel-environment.ts',
  'src/runtime/cleanup.ts',
]);
const serviceRuntimeDependencies = new Set([
  'src/runtime/cleanup.ts',
  'src/runtime/native-service-lifetime.ts',
  'src/runtime/native-service-context.ts',
  'src/runtime/native-event-channel.ts',
  'src/runtime/operations.ts',
]);
const nativeContracts = new Set([
  'src/native/native-object.ts',
  'src/native/native-contracts.ts',
  'src/native/message-contracts.ts',
]);
const featurePorts = new Set([
  'src/runtime/media-contracts.ts',
  'src/runtime/native-event-channel.ts',
  'src/runtime/native-service-context.ts',
]);
const facadeInputs = new Set([
  'src/features/contacts/friend-categories.ts',
  'src/features/forward/merged-forward-input.ts',
  'src/features/forward/forward-resource-wire.ts',
  'src/features/messages/send-input.ts',
  'src/features/messages/query-input.ts',
  'src/features/messages/face-input.ts',
  'src/features/media/download-input.ts',
  'src/features/groups/group-essence-input.ts',
  'src/features/groups/group-file-input.ts',
]);

// Cross-domain collaboration is reviewed at exact module pairs. A new feature
// does not gain permission to import an entire neighboring feature directory.
export const crossFeatureDependencies = [
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
    from: 'src/features/forward/merged-forward-input.ts',
    to: 'src/features/messages/send-input.ts',
    reason: 'Forward nodes share validated message input capture.',
  },
  {
    from: 'src/features/messages/message-elements.ts',
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
  if (!to.startsWith('src/')) {
    if (from === 'src/runtime/kernel-environment.ts')
      return ['node:fs/promises', 'node:path', 'node:os'].includes(to)
        ? undefined
        : 'Environment preparation owns local configuration, not transports or account actions.';
    if (from === 'src/worker.ts')
      return ['node:os', 'node:fs/promises'].includes(to)
        ? undefined
        : 'The worker only acquires its reviewed process and directory dependencies.';
    if (from === 'src/kernel.ts' || from === 'src/native-services.ts')
      return 'Authentication and service composition delegate IO to their resource owners.';
    if (from === 'src/native/native-bundle-installer.ts')
      return [
        'node:crypto',
        'node:zlib',
        'node:fs',
        'node:fs/promises',
        'node:path',
        'node:os',
      ].includes(to)
        ? undefined
        : 'The bundle installer uses its injected download port rather than owning network selection.';
    if (from === 'src/storage/native-package-lock.ts')
      return ['node:crypto', 'node:fs/promises'].includes(to)
        ? undefined
        : 'Package locking only owns lock publication, waiting and reclamation.';
    if (from === 'src/client/qq-client.ts')
      return to === 'node:events' || (typeOnly && to === 'node:child_process')
        ? undefined
        : 'The public facade delegates IO and process ownership to its lifetime owner.';
    if (from === 'src/client/create-client.ts')
      return [
        'node:child_process',
        'node:fs',
        'node:fs/promises',
        'node:path',
        'node:url',
      ].includes(to)
        ? undefined
        : 'The factory only loads its reviewed Node bootstrap dependencies.';
    return 'External dependencies require reviewed module ownership.';
  }
  if (from === 'src/native/native-bundle-installer.ts')
    return to === 'src/storage/native-package-lock.ts' ||
      (typeOnly && to === 'src/contracts/native.ts')
      ? undefined
      : 'The installer cannot depend on bundle source selection or account composition.';
  if (to === 'src/native/native-bundle-installer.ts' && from !== 'src/native/native-package.ts')
    return 'Only verified bundle preparation may dispatch an installation.';
  if (from === 'src/storage/native-package-lock.ts')
    return to === 'src/storage/process-lock.ts'
      ? undefined
      : 'Package locking uses the shared process-lock primitive, not bundle management.';
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
      : 'The worker owns IPC and native bootstrap, not domain operation composition.';
  if (from === 'src/kernel.ts')
    return kernelDependencies.has(to) || (typeOnly && to === 'src/native/native-object.ts')
      ? undefined
      : 'Authentication composes its environment and account lifetime, not feature implementations.';
  if (from === 'src/native-services.ts')
    return to.startsWith('src/features/') ||
      serviceRuntimeDependencies.has(to) ||
      to === 'src/native/native-contracts.ts' ||
      (typeOnly && nativeContracts.has(to))
      ? undefined
      : 'Service composition cannot acquire bundles, account directories or authentication owners.';
  if (from === 'src/runtime/kernel-environment.ts')
    return typeOnly &&
      ['src/native/native-object.ts', 'src/runtime/account-session-lifecycle.ts'].includes(to)
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
    if (typeOnly && (nativeContracts.has(to) || featurePorts.has(to))) return;
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
      to === 'src/runtime/client-lifecycle.ts' ||
      (typeOnly && to === 'src/runtime/operations.ts')
      ? undefined
      : 'The facade cannot import native execution or feature operation implementations.';
  if (from === 'src/client/create-client.ts')
    return to === 'src/client/qq-client.ts' ||
      to === 'src/native/native-package.ts' ||
      to === 'src/native/login-request.ts'
      ? undefined
      : 'Client creation selects its native bundle and constructs the public facade.';
  if (from === 'src/cli.ts' || from.startsWith('src/cli/'))
    return to === 'src/index.ts' ||
      to.startsWith('src/cli/') ||
      facadeInputs.has(to) ||
      to === 'src/runtime/cleanup.ts' ||
      (from === 'src/cli.ts' && to === 'src/native/native-package.ts')
      ? undefined
      : 'CLI uses the public client, input capture and its own execution modules.';
  return 'Source ownership is unclassified; assign its layer before adding dependencies.';
}
