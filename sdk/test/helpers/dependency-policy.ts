/** Architectural policy includes type edges: an erased import can still couple
 * ownership and force coordinated changes between otherwise independent modules.
 */
export interface SourceDependency {
  from: string;
  to: string;
  typeOnly: boolean;
}

const primitives = new Set(['src/types.ts', 'src/errors.ts']);
const composition = new Set(['src/worker.ts', 'src/kernel.ts', 'src/native-services.ts']);
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
]);

// Cross-domain collaboration is reviewed at exact module pairs. A new feature
// does not gain permission to import an entire neighboring feature directory.
export const crossFeatureDependencies = [
  {
    from: 'src/features/groups/group-essence-input.ts',
    to: 'src/features/messages/send-input.ts',
    reason: 'Essence actions share pure group identifier validation.',
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
  if (primitives.has(from))
    return from === 'src/errors.ts' && to === 'src/types.ts'
      ? undefined
      : 'Public primitives cannot depend on implementation.';
  if (primitives.has(to)) return;
  if (composition.has(from))
    return to === 'src/index.ts' || to === 'src/cli.ts' || to.startsWith('src/cli/')
      ? 'Native composition cannot depend on application entry points.'
      : undefined;
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
    return facadeInputs.has(to) ||
      to === 'src/runtime/client-lifecycle.ts' ||
      to === 'src/runtime/operations.ts' ||
      (typeOnly && to === 'src/runtime/media-contracts.ts') ||
      to === 'src/native/native-package.ts' ||
      to === 'src/native/login-request.ts'
      ? undefined
      : 'The facade cannot import native execution or feature operation implementations.';
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
