import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateRelease } from '../sdk/scripts/local-first-publish.mjs';

/** Bind the aggregate consumer's exact bytes after its successful CI execution. */
export async function finalizeRelease(directory, env = process.env) {
  const root = resolve(directory);
  const release = await validateRelease(root);
  const manifest = release.manifest;
  if (manifest.repository !== env.GITHUB_REPOSITORY || manifest.commit !== env.GITHUB_SHA ||
      manifest.runId !== env.GITHUB_RUN_ID || manifest.runAttempt !== Number(env.GITHUB_RUN_ATTEMPT)) {
    throw new Error('Release differs from current CI identity');
  }
  const path = 'evidence/aggregated-main.consumer.json';
  const bytes = await readFile(join(root, path));
  const next = { ...manifest, schemaVersion: 2, aggregateReceipt: {
    path, sha256: createHash('sha256').update(bytes).digest('hex'),
  } };
  // All package/receipt checks completed before replacing the existing manifest.
  const temporary = join(root, `.release-manifest-${process.pid}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, join(root, 'release-manifest.json'));
  } finally { await rm(temporary, { force: true }); }
  return next;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw new Error('Usage: node ci/finalize-release.mjs');
  await finalizeRelease('release');
  console.log('Validated seven packages and bound aggregate receipt in schema 2');
}
