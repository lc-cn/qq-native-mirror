/** Exact resource owners. New source files do not inherit a directory's IO or
 * third-party permissions; type-only process contracts cannot become loaders.
 */
export const externalRuntimeDependencies: Readonly<Record<string, readonly string[]>> = {
  'src/cli.ts': ['node:fs', 'node:fs/promises', 'node:path', 'node:url'],
  'src/cli/command-plan.ts': ['node:fs/promises', 'node:path'],
  'src/client/create-client.ts': [
    'node:child_process',
    'node:fs',
    'node:fs/promises',
    'node:path',
    'node:url',
  ],
  'src/client/qq-client.ts': ['node:events'],
  'src/features/contacts/friend-system-events.ts': ['node:crypto'],
  'src/features/forward/forward-resource-wire.ts': ['node:zlib'],
  'src/features/forward/long-message-request.ts': ['node:zlib'],
  'src/features/forward/long-message-response.ts': ['node:util'],
  'src/features/forward/merged-forward.ts': ['node:crypto'],
  'src/features/groups/group-notices.ts': ['node:fs/promises', 'node:path'],
  'src/features/groups/group-system-events.ts': ['node:crypto'],
  'src/features/media/builtin-record-codec.ts': ['node:fs/promises', 'silk-wasm'],
  'src/features/media/download-input.ts': ['node:path'],
  'src/features/media/media-operations.ts': ['node:fs', 'node:fs/promises', 'node:path'],
  'src/features/media/media-record.ts': [
    'node:crypto',
    'node:fs',
    'node:fs/promises',
    'node:os',
    'node:path',
  ],
  'src/features/media/media-send.ts': [
    'node:child_process',
    'node:crypto',
    'node:fs',
    'node:fs/promises',
    'node:path',
    'node:util',
  ],
  'src/features/media/record-codec-loader.ts': ['node:fs/promises', 'node:path', 'node:url'],
  'src/features/media/video-codec-loader.ts': [
    'node:fs/promises',
    'node:module',
    'node:path',
    'node:url',
  ],
  'src/features/messages/message-elements.ts': ['node:crypto', 'node:fs/promises', 'node:path'],
  'src/features/messages/send-input.ts': ['node:path'],
  'src/native/native-bundle-installer.ts': [
    'node:crypto',
    'node:fs',
    'node:fs/promises',
    'node:os',
    'node:path',
    'node:zlib',
  ],
  'src/native/native-contracts.ts': ['node:crypto', 'node:fs'],
  'src/native/native-installed-storage.ts': [
    'node:crypto',
    'node:fs',
    'node:fs/promises',
    'node:path',
    'node:zlib',
  ],
  'src/native/native-package.ts': [
    'node:crypto',
    'node:fs/promises',
    'node:module',
    'node:os',
    'node:path',
  ],
  'src/runtime/account-session-lifecycle.ts': ['node:fs/promises', 'node:os', 'node:path'],
  'src/runtime/kernel-environment.ts': ['node:fs/promises', 'node:os', 'node:path'],
  'src/storage/data-directory-lock.ts': ['node:crypto', 'node:fs', 'node:path'],
  'src/storage/native-package-lock.ts': ['node:crypto', 'node:fs/promises'],
  'src/storage/process-lock.ts': ['node:crypto', 'node:fs'],
  'src/worker.ts': ['node:fs/promises', 'node:os'],
};

export const externalTypeDependencies: Readonly<Record<string, readonly string[]>> = {
  'src/client/qq-client.ts': ['node:child_process'],
  'src/runtime/client-lifecycle.ts': ['node:child_process'],
  'src/runtime/worker-termination.ts': ['node:child_process'],
};

export function externalDependencyViolation(from: string, to: string, typeOnly: boolean) {
  const allowed = typeOnly ? externalTypeDependencies : externalRuntimeDependencies;
  return allowed[from]?.includes(to)
    ? undefined
    : 'External dependency requires an exact reviewed resource owner and import kind.';
}
