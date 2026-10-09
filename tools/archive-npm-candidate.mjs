import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { writeFile, lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateRelease } from '../sdk/scripts/local-first-publish.mjs';
const execute = promisify(execFile);
const repository = 'lc-cn/qq-native-mirror';
const requireThat = (value, message) => { if (!value) throw new Error(message); };
export function validateSourceRun(run, runId, sha) {
  requireThat(typeof runId === 'string' && /^[1-9]\d*$/.test(runId) && /^[a-f0-9]{40}$/.test(sha), 'Invalid source run/SHA input');
  requireThat(String(run.id) === runId && run.repository?.full_name === repository && run.path === '.github/workflows/native-npm.yml' && run.status === 'completed' && run.conclusion === 'success' && run.head_sha === sha && Number.isInteger(run.run_attempt) && run.run_attempt > 0, 'Source CI identity or success gate failed');
  return run.run_attempt;
}
async function command(binary, args) {
  try { return (await execute(binary, args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 120_000 })).stdout; }
  catch { throw new Error(`Archive ${binary} operation failed`); }
}
async function sourceRun(runId) {
  requireThat(typeof runId === 'string' && /^[1-9]\d*$/.test(runId), 'Invalid source run input');
  return JSON.parse(await command('gh', ['api', `repos/${repository}/actions/runs/${runId}`]));
}
export async function archiveCandidate({ runId, sha, directory = 'release', archiveRunId }, dependencies = {}) {
  const readRun = dependencies.readRun ?? sourceRun;
  const runCommand = dependencies.command ?? command;
  const validate = dependencies.validate ?? validateRelease;
  const first = await readRun(runId), attempt = validateSourceRun(first, runId, sha);
  requireThat(typeof archiveRunId === 'string' && /^[1-9]\d*$/.test(archiveRunId), 'Invalid archive run');
  const root = resolve(directory), release = await validate(root), manifest = release.manifest;
  requireThat(manifest.schemaVersion === 2 && manifest.repository === repository && manifest.runId === runId && manifest.commit === sha && manifest.runAttempt === attempt, 'Artifact manifest differs from successful source run');
  // Require ordinary files, preserving tarball bytes and preventing link archiving.
  for (const row of release.packages) requireThat((await lstat(row.path)).isFile() && !(await lstat(row.path)).isSymbolicLink(), 'Linked package artifact rejected');
  const second = await readRun(runId);
  requireThat(validateSourceRun(second, runId, sha) === attempt, 'Source CI changed during archive validation');
  const evidence = join(root, 'acceptance-evidence.tar.gz');
  await runCommand('tar', ['-czf', evidence, '-C', root, 'evidence']);
  const notes = join(root, 'archive-notes.md');
  await writeFile(notes, `Immutable npm candidate from successful native CI https://github.com/${repository}/actions/runs/${runId} (attempt ${attempt}).\nSource commit: ${sha}.\nArchived by separate workflow https://github.com/${repository}/actions/runs/${archiveRunId}.\nNo npm publication, native initialization or account login was performed.\n`);
  await runCommand('gh', ['release', 'create', `npm-v${manifest.version}-ci-${runId}`, ...release.packages.map(row => row.path), join(root, 'release-manifest.json'), evidence, '--repo', repository, '--target', sha, '--prerelease', '--latest=false', '--title', `npm ${manifest.version} CI candidate ${runId}`, '--notes-file', notes]);
  return { sourceRunId: runId, archiveRunId, sourceCommit: sha, version: manifest.version, assets: 9 };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const runId = process.env.SOURCE_RUN_ID, sha = process.env.SOURCE_SHA;
    if (process.argv[2] === '--preflight' && process.argv.length === 3) {
      validateSourceRun(await sourceRun(runId), runId, sha);
      console.log('Source native CI success and identity verified');
    } else {
      requireThat(process.argv.length === 2, 'Invalid archive helper arguments');
      console.log(JSON.stringify(await archiveCandidate({ runId, sha, archiveRunId: process.env.GITHUB_RUN_ID })));
    }
  } catch { console.error('Candidate archive validation or operation failed'); process.exitCode = 1; }
}
