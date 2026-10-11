import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
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

test('exact entry and glue permissions do not authorize neighboring executors', () => {
  const f = fixture();
  try {
    const safe = join(f.root, 'safe');
    mkdirSync(safe);
    const entry = f.write('entry.mjs', `import './safe/helper.mjs';`);
    writeFileSync(join(safe, 'helper.mjs'), `import '../glue.mjs';`);
    const glue = f.write(
      'glue.mjs',
      `await import(pathToFileURL(join(root,'dist/index.js')).href);`,
    );
    const marker = join(f.root, 'executed');
    f.write('acceptance.mjs', `writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    const options = {
      entries: [entry],
      distRoot: f.dist,
      helperRoots: [safe],
      helperFiles: [entry, glue],
    };
    const collect = () => collectConsumerModuleReferences(options);
    assert.equal(collect().helpers.length, 3);
    for (const statement of [
      `import {run} from './acceptance.mjs';`,
      `import './acceptance.mjs';`,
      `export * from './acceptance.mjs';`,
      `await import('./acceptance.mjs');`,
    ]) {
      f.write('glue.mjs', statement);
      assert.throws(collect, /Helper import escapes reviewed roots/);
    }
    f.write('glue.mjs', `import './neighbor.mjs';`);
    f.write('neighbor.mjs', `import './acceptance.mjs';`);
    assert.throws(collect, /Helper import escapes reviewed roots/);
    assert.throws(
      () =>
        collectConsumerModuleReferences({ ...options, entries: [join(f.root, 'acceptance.mjs')] }),
      /Entry escapes reviewed roots/,
    );
    assert.throws(
      () => collectConsumerModuleReferences({ ...options, helperFiles: [safe] }),
      /canonical regular file/,
    );
    assert.equal(existsSync(marker), false);
  } finally {
    f.close();
  }
});

test(
  'exact-file permissions reject symlink aliases',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    try {
      const safe = join(f.root, 'safe');
      mkdirSync(safe);
      const glue = f.write('glue.mjs', '');
      const alias = join(f.root, 'alias.mjs');
      symlinkSync(glue, alias);
      const entry = f.write('entry.mjs', `import './alias.mjs';`);
      const options = {
        entries: [entry],
        distRoot: f.dist,
        helperRoots: [safe],
        helperFiles: [entry, glue],
      };
      assert.throws(
        () => collectConsumerModuleReferences(options),
        /Helper import escapes reviewed roots/,
      );
      assert.throws(
        () => collectConsumerModuleReferences({ ...options, helperFiles: [entry, alias] }),
        /canonical regular file/,
      );
    } finally {
      f.close();
    }
  },
);

test(
  'relative SDK dist references cannot authorize neighboring dist executors or symlink escapes',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    try {
      const safe = join(f.root, 'safe');
      mkdirSync(safe);
      const outside = join(f.root, 'acceptance/dist');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'index.js'), 'throw new Error("must not execute");');
      const entry = join(safe, 'entry.mjs');
      const collect = () =>
        collectConsumerModuleReferences({
          entries: [entry],
          distRoot: f.dist,
          helperRoots: [safe],
        });
      writeFileSync(join(f.dist, 'index.js'), '');
      writeFileSync(entry, `import '../dist/index.js';import '../dist/missing.js';`);
      assert.deepEqual(
        collect().references.map((value) => value.path),
        ['index.js', 'missing.js'],
      );
      assert.deepEqual(collect().missing, ['missing.js']);
      writeFileSync(entry, `import '../acceptance/dist/index.js';`);
      assert.throws(collect, /Helper import escapes reviewed roots/);
      symlinkSync(join(outside, 'index.js'), join(f.dist, 'alias.js'));
      writeFileSync(entry, `import '../dist/alias.js';`);
      assert.throws(collect, /Helper import escapes reviewed roots/);
      symlinkSync(outside, join(f.dist, 'linked'));
      writeFileSync(entry, `import '../dist/linked/missing.js';`);
      assert.throws(collect, /Helper import escapes reviewed roots|ENOENT/);
    } finally {
      f.close();
    }
  },
);

test(
  'installed join and finite loader references reject dist symlinks escaping the SDK',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    try {
      const outside = join(f.root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'executor.js'), 'throw new Error("must not execute");');
      symlinkSync(join(outside, 'executor.js'), join(f.dist, 'alias.js'));
      symlinkSync(outside, join(f.dist, 'linked'));
      for (const source of [
        `await import(pathToFileURL(join(root,'dist/alias.js')).href);`,
        `const load=(name)=>import(pathToFileURL(join(root,'dist',name)).href);await load('alias.js');`,
        `await import(pathToFileURL(join(root,'dist/linked/missing.js')).href);`,
      ]) {
        const entry = f.write('entry.mjs', source);
        assert.throws(() => f.collect(entry), /Invalid installed module path/);
      }
      const entry = f.write(
        'entry.mjs',
        `await import(pathToFileURL(join(root,'dist/missing.js')).href);`,
      );
      assert.deepEqual(f.collect(entry).missing, ['missing.js']);
    } finally {
      f.close();
    }
  },
);
