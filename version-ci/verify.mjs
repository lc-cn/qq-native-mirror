import { mkdtemp, writeFile, copyFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runVersionDriver } from './driver-transaction.mjs';
import { npm } from '../ci/npm.mjs';
import { readMainArtifact } from './main-artifact.mjs';
import { readSourceCatalog, readSourceLegacyManifest } from './build-main-contract.mjs';

/** @type {string|undefined} */
let temporary;
await runVersionDriver(
  async () => {
    await rm('out/version-consumer.json', { force: true });
    await rm('out/version-consumer-driver-error.json', { force: true });
    temporary = await mkdtemp(join(tmpdir(), 'qq-version-installed-'));
    if (!process.env.EXPECTED_MAIN_SOURCE_SHA256) throw Error('Missing shared producer seal');
    const artifact = await readMainArtifact();
    const mode = process.env.NATIVE_CATALOG_MODE ?? 'public-default';
    if (!['public-default', 'legacy-bridge-candidate'].includes(mode))
      throw Error('Unknown catalog mode');
    if (mode === 'legacy-bridge-candidate' && artifact.source.mode !== 'current-source')
      throw Error('Candidate requires current source');
    if (!process.env.GITHUB_SHA) throw Error('Missing workflow source');
    const catalogName =
      mode === 'public-default' ? 'catalog.json' : 'catalog-linux-legacy-bridge-v1.json';
    const catalogBytes = readSourceCatalog(process.env.GITHUB_SHA, catalogName);
    const catalogPath = join(temporary, 'selection-catalog.json');
    await writeFile(catalogPath, catalogBytes);
    let manifestPath;
    if (mode === 'legacy-bridge-candidate') {
      const catalog = /** @type {{packages:import('./mirror-selection.mjs').Selected[]}} */ (
        JSON.parse(catalogBytes.toString('utf8'))
      );
      const selected = catalog.packages.find(
        (row) =>
          row.platform === process.platform &&
          row.arch === process.arch &&
          row.version.clientVersion === process.env.TARGET_VERSION,
      );
      if (!selected) throw Error('Candidate target missing');
      manifestPath = join(temporary, 'candidate-manifest.json');
      await writeFile(
        manifestPath,
        readSourceLegacyManifest(process.env.GITHUB_SHA, selected.manifestUrl),
      );
    }
    await writeFile(
      join(temporary, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    );
    execFileSync(
      npm[0],
      [
        ...npm[1],
        'install',
        resolve(artifact.path),
        '--omit=optional',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--cache',
        join(temporary, 'npm-cache'),
      ],
      { cwd: temporary, stdio: 'inherit' },
    );
    for (const name of await readdir(join(temporary, 'node_modules')))
      if (name.startsWith('qq-native-client-')) throw Error('Native auxiliary installed');
    for (const name of ['consumer.mjs', 'main-artifact.mjs', 'mirror-selection.mjs'])
      await copyFile(`version-ci/${name}`, join(temporary, name));
    /** @type {NodeJS.ProcessEnv} */
    const env = {
      ...process.env,
      SOURCE_FILE: resolve('out/main-source.json'),
      CATALOG_FILE: catalogPath,
      RECEIPT_FILE: resolve('out/version-consumer.json'),
    };
    delete env.CANDIDATE_MANIFEST_FILE;
    if (manifestPath) env.CANDIDATE_MANIFEST_FILE = manifestPath;
    for (const name of Object.keys(env))
      if (/TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)) delete env[name];
    execFileSync(process.execPath, [join(temporary, 'consumer.mjs')], {
      cwd: temporary,
      env,
      stdio: 'inherit',
    });
  },
  async (error, stage) => {
    const failure = {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      clientVersion: process.env.TARGET_VERSION,
      currentRun: process.env.GITHUB_RUN_ID,
      selectionMode: process.env.NATIVE_CATALOG_MODE ?? 'public-default',
      stage: stage === 'cleanup' ? 'cleanup' : 'install-or-runtime',
      success: false,
      loginAttempted: false,
      errorCode:
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'DRIVER_FAILED',
    };
    await writeFile('out/version-consumer-driver-error.json', JSON.stringify(failure));
    try {
      await access('out/version-consumer.json');
    } catch {
      await writeFile('out/version-consumer.json', JSON.stringify(failure));
    }
  },
  async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  },
);
