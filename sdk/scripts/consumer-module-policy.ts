import { resolve, sep } from 'node:path';
import type { ConsumerModuleReferencesOptions } from './consumer-module-references.ts';

/** Shared consumer-role policy for local preflight and CI installed-module checks.
 * Only the consumer directory is open to new helpers. Other scripts are reviewed
 * exact files; accepting one glue module never grants access to its neighbors.
 */
export function consumerModulePolicy(repositoryRoot: string): ConsumerModuleReferencesOptions {
  const root = resolve(repositoryRoot) + sep;
  const script = (name: string) => resolve(root, 'sdk/scripts/consumers', name);
  const exceptions = [
    {
      file: script('worker-bootstrap-consumer-contract.mjs'),
      expression: "import(pathToFileURL(join(dist, 'index.js')).href)",
      modules: ['index.js'],
      reason:
        'Fixture dist variable is installedRoot/dist; child hook text is separately exercised.',
    },
    {
      file: script('client-factory-consumer-contract.mjs'),
      expression: 'import(pathToFileURL(entry).href)',
      modules: ['index.js'],
      reason: 'Fixture generated entry reexports the public package; source mode also exists.',
    },
    {
      file: script('client-factory-consumer-contract.mjs'),
      expression:
        'import(pathToFileURL(join(packageRoot, tree, `client/qq-client.${extension}`)).href)',
      modules: ['client/qq-client.js'],
      reason: 'Finite source/compiled fixture mode, compiled module checked here.',
    },
    {
      file: script('public-contract-consumer.mjs'),
      expression: "import(pathToFileURL(join(compilerRoot, 'lib/typescript.js')).href)",
      modules: [],
      reason: 'Explicit external compiler path, not SDK module.',
    },
    ...[
      ['features/groups/group-file-pages', 'features/groups/group-file-pages.js'],
      ['features/groups/group-file-input', 'features/groups/group-file-input.js'],
      ['native-services', 'native-services.js'],
      ['runtime/worker-termination', 'runtime/worker-termination.js'],
      ['index', 'index.js'],
      ['cli', 'cli.js'],
    ].map(([source, compiled]) => ({
      file: script('group-file-pages-consumer-contract.mjs'),
      expression: `import(pathToFileURL(join(packageRoot, 'src/${source}.ts')).href)`,
      modules: [compiled],
      reason: 'Finite source-only fixture branch; its exact compiled counterpart is checked here.',
    })),
  ];
  return {
    entries: [
      `${root}ci/verify-consumer.mjs`,
      `${root}ci/current-source-mirror.mjs`,
      `${root}sdk/scripts/verify-package-consumer.mjs`,
    ],
    distRoot: `${root}sdk/dist`,
    helperRoots: [`${root}sdk/scripts/consumers`],
    helperFiles: [
      `${root}ci/verify-consumer.mjs`,
      `${root}ci/current-source-mirror.mjs`,
      `${root}sdk/scripts/verify-package-consumer.mjs`,
      `${root}ci/npm.mjs`,
      `${root}ci/consumer-resources.mjs`,
      `${root}version-ci/main-artifact.mjs`,
      `${root}version-ci/build-main-contract.mjs`,
    ],
    exceptions,
  };
}
