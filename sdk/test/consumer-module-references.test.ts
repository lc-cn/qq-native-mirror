import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectConsumerModuleReferences } from '../scripts/consumer-module-references.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'consumer-references-'));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  const write = (name: string, text: string) => {
    const file = join(root, name);
    writeFileSync(file, text);
    return file;
  };
  const collect = (entry: string) =>
    collectConsumerModuleReferences({ entries: [entry], distRoot: dist, helperRoots: [root] });
  return {
    root,
    dist,
    write,
    collect,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
test('literal loader and segmented joins discover real references while comments are ignored', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dist, 'index.js'), '');
    const entry = f.write(
      'entry.mjs',
      `// import('dist/comment-only.js')
 const load=(name)=>import(pathToFileURL(join(packageRoot,'dist',name)).href);
 await load('missing.js');
 await import(pathToFileURL(join(packageRoot,'dist','index.js')).href);
 `,
    );
    const result = f.collect(entry);
    assert.deepEqual(
      result.references.map((ref) => ref.path),
      ['missing.js', 'index.js'],
    );
    assert.deepEqual(result.missing, ['missing.js']);
  } finally {
    f.close();
  }
});
test('side effect, reexport and literal dynamic helper imports recurse with cycle protection', () => {
  const f = fixture();
  try {
    const entry = f.write(
      'entry.mjs',
      `import './a.mjs';export * from './b.mjs';await import('./c.mjs');`,
    );
    f.write(
      'a.mjs',
      `import './entry.mjs';await import(pathToFileURL(join(packageRoot,'dist/a.js')).href);`,
    );
    f.write('b.mjs', `await import(pathToFileURL(join(packageRoot,'dist/b.js')).href);`);
    f.write('c.mjs', `await import(pathToFileURL(join(packageRoot,'dist/c.js')).href);`);
    const result = f.collect(entry);
    assert.equal(result.helpers.length, 4);
    assert.deepEqual(result.missing, ['a.js', 'b.js', 'c.js']);
  } finally {
    f.close();
  }
});
test('computed loader arguments are rejected with source location', () => {
  const f = fixture();
  try {
    const entry = f.write(
      'entry.mjs',
      `const load=(path)=>import(pathToFileURL(join(packageRoot,'dist',path)).href);\nawait load(variable);`,
    );
    assert.throws(() => f.collect(entry), /entry\.mjs:2: Computed installed loader argument/);
  } finally {
    f.close();
  }
});

test('transform-wrapped import and shadowed loader cannot masquerade as verified paths', () => {
  const f = fixture();
  try {
    const wrapped = f.write(
      'wrapped.mjs',
      `await import(transform(pathToFileURL(join(root,'dist/index.js')).href));`,
    );
    assert.throws(() => f.collect(wrapped), /Unreviewed computed import/);
    const shadow = f.write(
      'shadow.mjs',
      `const load=(name)=>import(pathToFileURL(join(root,'dist',name)).href); function nested(load){ load('invented.js'); }`,
    );
    assert.throws(() => f.collect(shadow), /Unreviewed installed loader binding/);
  } finally {
    f.close();
  }
});
test('directories are not modules and stale exact exceptions fail closed', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.dist, 'directory.js'));
    const entry = f.write(
      'entry.mjs',
      `await import(pathToFileURL(join(root,'dist/directory.js')).href);`,
    );
    assert.deepEqual(f.collect(entry).missing, ['directory.js']);
    assert.throws(
      () =>
        collectConsumerModuleReferences({
          entries: [entry],
          distRoot: f.dist,
          helperRoots: [f.root],
          exceptions: [
            { file: entry, expression: 'import(variable)', modules: [], reason: 'unused' },
          ],
        }),
      /Unused computed import exception/,
    );
  } finally {
    f.close();
  }
});

test('private loader forwarding remains bounded to validated factory arguments', () => {
  const f = fixture();
  try {
    const source = `const load=(name)=>import(pathToFileURL(join(root,'dist',name)).href); function read(load){load('inner.js');} read(load);`;
    const entry = f.write('entry.mjs', source);
    assert.deepEqual(f.collect(entry).missing, ['inner.js']);
    f.write('entry.mjs', source + `read(other);`);
    assert.throws(() => f.collect(entry), /Unreviewed installed loader forwarding/);
  } finally {
    f.close();
  }
});

test('reviewed loader aliases and external escapes fail closed instead of omitting modules', () => {
  const f = fixture();
  try {
    const factory = `const load=(name)=>import(pathToFileURL(join(root,'dist',name)).href);`;
    for (const suffix of [`const alias=load; await alias('missing.js');`, `external(load);`]) {
      const entry = f.write('entry.mjs', factory + suffix);
      assert.throws(() => f.collect(entry), /Unreviewed installed loader escape/);
    }
    const entry = f.write(
      'entry.mjs',
      `await import(pathToFileURL(join(root,'notdist/index.js')).href);`,
    );
    assert.throws(() => f.collect(entry), /Unreviewed computed import/);
  } finally {
    f.close();
  }
});

test('syntax-invalid helper cannot silently pass a reference-free AST', () => {
  const f = fixture();
  try {
    const entry = f.write('entry.mjs', `import './broken.mjs';`);
    f.write('broken.mjs', `const impossible = ;`);
    assert.throws(() => f.collect(entry), /broken\.mjs:1: Invalid consumer syntax/);
  } finally {
    f.close();
  }
});
