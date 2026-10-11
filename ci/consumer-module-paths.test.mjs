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
import { consumerModulePolicy } from '../sdk/scripts/consumer-module-policy.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = (name) =>
  fileURLToPath(new URL(`../sdk/scripts/consumers/${name}`, import.meta.url));
const options = consumerModulePolicy(root);
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
