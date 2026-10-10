import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const consumer = new URL('./verify-consumer.mjs', import.meta.url);
const sdk = new URL('../sdk/', import.meta.url);
const scripts = new URL('../sdk/scripts/', import.meta.url);

function consumerSources(entry, visited = new Set()) {
  if (visited.has(entry.href)) return [];
  visited.add(entry.href);
  const source = readFileSync(entry, 'utf8');
  const nested = [...source.matchAll(/\bfrom\s+['"]([^'"]+\.mjs)['"]/g)].flatMap(([, path]) => {
    if (!path.startsWith('.')) return [];
    const target = new URL(path, entry);
    return target.href.startsWith(scripts.href) ? consumerSources(target, visited) : [];
  });
  return [source, ...nested];
}

// CI embeds installed-module URLs and rewrites verifier imports. Check those
// references without loading the addon or acquiring an account directory.
function missingModules(source) {
  const paths = new Set(source.match(/\bdist\/[A-Za-z0-9_./-]+\.js\b/g));
  assert.ok(paths.size > 10, 'Installed consumer module references were not discovered');
  return [...paths].filter((path) => !existsSync(new URL(path, sdk)));
}

test('native CI and its shared consumers reference only modules in the clean SDK build', () => {
  assert.deepEqual(missingModules(consumerSources(consumer).join('\n')), []);
});

test('removed installed module fails before native initialization', () => {
  const source = consumerSources(consumer).join('\n').replaceAll(
    'dist/features/messages/face-input.js',
    'dist/features/messages/message-elements.js',
  );
  const obsolete = new URL('dist/features/messages/message-elements.js', sdk);
  assert.equal(existsSync(obsolete), false, fileURLToPath(obsolete));
  assert.deepEqual(missingModules(source), ['dist/features/messages/message-elements.js']);
});
