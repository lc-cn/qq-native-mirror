import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumerModulePolicy } from '../scripts/consumer-module-policy.ts';
import { collectConsumerModuleReferences } from '../scripts/consumer-module-references.ts';

function fixture() {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'consumer-role-policy-')));
  const actual = consumerModulePolicy(repository);
  const copy = (file: string) => {
    const target = join(root, relative(repository, file));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  };
  for (const file of actual.helperFiles ?? []) copy(file);
  for (const directory of actual.helperRoots)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.ok(entry.isFile(), 'consumer roles contain regular source files');
      copy(join(directory, entry.name));
    }
  const policy = consumerModulePolicy(root);
  const consumers = join(root, 'sdk/scripts/consumers');
  const consumer = join(consumers, 'face-consumer-contract.mjs');
  return {
    root,
    consumers,
    consumer,
    original: readFileSync(consumer, 'utf8'),
    collect: () => collectConsumerModuleReferences(policy),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('production role policy checks copied real closures before a dist build and permits safe helpers', () => {
  const f = fixture();
  try {
    const before = f.collect();
    assert.ok(before.missing.length > 0, 'role preflight does not prove installed modules exist');
    const safe = join(f.consumers, 'additional-safe-helper.mjs');
    writeFileSync(safe, `await import(pathToFileURL(join(root,'dist/role-probe.js')).href);`);
    writeFileSync(f.consumer, `import './additional-safe-helper.mjs';\n${f.original}`);
    const after = f.collect();
    assert.ok(after.helpers.includes(safe));
    assert.ok(after.missing.includes('role-probe.js'));
    assert.equal(existsSync(join(f.root, 'sdk/dist')), false);
  } finally {
    f.close();
  }
});

test('production role policy rejects adjacent acceptance and publish executors without executing them', () => {
  const f = fixture();
  try {
    const marker = join(f.root, 'executor-ran');
    const executor = `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');`;
    writeFileSync(join(f.root, 'sdk/scripts/verify-sdk-002-readonly-v3.ts'), executor);
    writeFileSync(join(f.root, 'ci/publish-executor.mjs'), executor);
    for (const target of ['../verify-sdk-002-readonly-v3.ts', '../../../ci/publish-executor.mjs']) {
      for (const statement of [
        `import {run} from '${target}';`,
        `import '${target}';`,
        `export * from '${target}';`,
        `await import('${target}');`,
      ]) {
        writeFileSync(f.consumer, `${statement}\n${f.original}`);
        assert.throws(f.collect, /Helper import escapes reviewed roots/);
        assert.equal(existsSync(marker), false);
      }
      writeFileSync(join(f.consumers, 'transitive-safe-helper.mjs'), `import '${target}';`);
      writeFileSync(f.consumer, `import './transitive-safe-helper.mjs';\n${f.original}`);
      assert.throws(f.collect, /Helper import escapes reviewed roots/);
      assert.equal(existsSync(marker), false);
    }
  } finally {
    f.close();
  }
});
