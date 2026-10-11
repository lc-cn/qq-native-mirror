import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { copyNativePackageSource } from './helpers/native-package-fixture.ts';
import { graph, sourceRoot } from './helpers/source-graph.ts';

async function destination(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qq-package-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('native source fixture copies transitive runtime bytes without type declarations or binaries', async (t) => {
  const directory = await destination(t);
  await copyNativePackageSource(directory);
  for (const file of ['native/native-response.ts', 'runtime/cleanup.ts'])
    assert.deepEqual(await readFile(join(directory, file)), await readFile(join(sourceRoot, file)));
  await assert.rejects(access(join(directory, 'contracts/client.ts')), { code: 'ENOENT' });
  await assert.rejects(access(join(directory, 'contracts/native.ts')), { code: 'ENOENT' });
  assert.ok(
    (await readdir(directory, { recursive: true })).every((file) => !file.endsWith('.node')),
  );
});

test('native source fixture follows a newly observed runtime dependency and tolerates its cycle', async (t) => {
  const response = join(sourceRoot, 'native/native-response.ts');
  const addition = join(sourceRoot, 'validation/identifiers.ts');
  const previousResponse = graph.get(response)!;
  const previousAddition = graph.get(addition)!;
  t.after(() => {
    graph.set(response, previousResponse);
    graph.set(addition, previousAddition);
  });
  // Change only the observed static graph in this test process, never SDK files.
  graph.set(response, [
    ...previousResponse,
    {
      specifier: '../validation/identifiers.ts',
      typeOnly: false,
      line: 1,
      target: addition,
    },
  ]);
  graph.set(addition, [
    ...previousAddition,
    {
      specifier: '../native/native-response.ts',
      typeOnly: false,
      line: 1,
      target: response,
    },
  ]);
  const directory = await destination(t);
  await copyNativePackageSource(directory);
  assert.deepEqual(
    await readFile(join(directory, 'validation/identifiers.ts')),
    await readFile(addition),
  );
});

test('native source fixture rejects unresolved runtime edges before copying any file', async (t) => {
  const entry = join(sourceRoot, 'native/native-package.ts');
  const previous = graph.get(entry)!;
  t.after(() => graph.set(entry, previous));
  for (const target of [undefined, join(sourceRoot, 'missing-fixture.ts')]) {
    graph.set(entry, [
      ...previous,
      {
        specifier: '../missing-fixture.ts',
        typeOnly: false,
        line: 1,
        ...(target === undefined ? {} : { target }),
      },
    ]);
    const directory = await destination(t);
    await assert.rejects(
      copyNativePackageSource(directory),
      /Native fixture (dependency is unresolved|source is absent)/,
    );
    assert.deepEqual(await readdir(directory), []);
  }
});
