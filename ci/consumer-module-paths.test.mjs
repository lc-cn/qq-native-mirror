import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectConsumerModuleReferences } from '../sdk/scripts/consumer-module-references.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = (name) => fileURLToPath(new URL(`../sdk/scripts/${name}`, import.meta.url));
const exceptions = [
  {
    file: script('worker-bootstrap-consumer-contract.mjs'),
    expression: "import(pathToFileURL(join(dist, 'index.js')).href)",
    modules: ['index.js'],
    reason: 'Fixture dist variable is installedRoot/dist; child hook text is separately exercised.',
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
];
const options = {
  entries: [
    `${root}ci/verify-consumer.mjs`,
    `${root}ci/current-source-mirror.mjs`,
    script('verify-package-consumer.mjs'),
  ],
  distRoot: `${root}sdk/dist`,
  helperRoots: [`${root}sdk/scripts`, `${root}ci`, `${root}version-ci`],
  exceptions,
};
test('native CI and local packed verifier helper closures reference the clean SDK build', () => {
  const result = collectConsumerModuleReferences(options);
  assert.deepEqual(result.missing, []);
  assert.ok(result.helpers.includes(script('forward-consumer-contract.mjs')));
  assert.ok(
    result.references.some((value) => value.path === 'features/forward/forward-messages.js'),
  );
});
test('removed installed module in actual helper source fails before native initialization', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'consumer-path-red-')));
  try {
    const helper = join(directory, 'face-consumer-contract.mjs');
    const original = readFileSync(script('face-consumer-contract.mjs'), 'utf8');
    assert.ok(original.includes('dist/features/messages/face-input.js'));
    writeFileSync(
      helper,
      original.replaceAll(
        'dist/features/messages/face-input.js',
        'dist/features/messages/message-elements.js',
      ),
    );
    const result = collectConsumerModuleReferences({
      entries: [helper],
      distRoot: options.distRoot,
      helperRoots: [directory],
    });
    assert.equal(existsSync(`${root}sdk/dist/features/messages/message-elements.js`), false);
    assert.deepEqual(result.missing, ['features/messages/message-elements.js']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
