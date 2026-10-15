import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const documents = ['docs/linux-signing-static.md', 'docs/signing-integrity.md'];

/** These two research documents name source-checkout tools, including prose
 * references outside shell fences. Historical private harnesses are named as
 * such instead of advertising a nonexistent checkout path.
 */
function references(): Map<string, Set<string>> {
  const tools = new Map<string, Set<string>>();
  for (const document of documents) {
    const lines = readFileSync(new URL(document, root), 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const [path] of line.matchAll(
        /(?<![\w./-])scripts\/[\w./-]+\.(?:py|ts|mjs|cjs|js|sh)\b/g,
      )) {
        const owners = tools.get(path) ?? new Set<string>();
        owners.add(`${document}:${index + 1}`);
        tools.set(path, owners);
      }
    });
  }
  return tools;
}

test('signing research documents reference tools available in the source checkout', () => {
  const tools = references();
  assert.ok(tools.size > 0, 'The documentation inventory must not be empty');
  for (const [path, owners] of tools) {
    assert.ok(!path.split('/').includes('..'), `Escaping research path: ${path}`);
    assert.ok(statSync(new URL(path, root)).isFile(), `${path}: ${[...owners].join(', ')}`);
  }
});

test('documented static tools retain their literal runpy dependency closure', () => {
  const pending = [...references().keys()].filter((path) => path.endsWith('.py'));
  const visited = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const source = readFileSync(new URL(path, root), 'utf8');
    // Check the actual literal imports used by these tools. This is a source
    // inventory, not a Python interpreter or native/signing execution test.
    for (const [, dependency] of source.matchAll(/runpy\.run_path\(['"]([^'"]+)['"]\)/g)) {
      assert.match(dependency, /^scripts\/[\w-]+\.py$/, `${path}: nonlocal dependency`);
      assert.ok(statSync(new URL(dependency, root)).isFile(), `${path} -> ${dependency}`);
      pending.push(dependency);
    }
  }
});
