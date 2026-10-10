import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const consumer = new URL('./verify-consumer.mjs', import.meta.url);
const sdk = new URL('../sdk/', import.meta.url);

// CI embeds installed-module URLs and rewrites verifier imports. Check those
// references without loading the addon or acquiring an account directory.
function missingModules(source) {
  const paths = new Set(source.match(/\bdist\/[A-Za-z0-9_./-]+\.js\b/g));
  assert.ok(paths.size > 10, 'Installed consumer module references were not discovered');
  return [...paths].filter((path) => !existsSync(new URL(path, sdk)));
}

test('native CI consumer references only modules in the clean SDK build', () => {
  assert.deepEqual(missingModules(readFileSync(consumer, 'utf8')), []);
});

test('removed installed module fails before native initialization', () => {
  const source = readFileSync(consumer, 'utf8').replaceAll(
    'dist/features/messages/face-input.js',
    'dist/features/messages/message-elements.js',
  );
  const obsolete = new URL('dist/features/messages/message-elements.js', sdk);
  assert.equal(existsSync(obsolete), false, fileURLToPath(obsolete));
  assert.deepEqual(missingModules(source), ['dist/features/messages/message-elements.js']);
});
