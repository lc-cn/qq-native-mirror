import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Derive a native host path in Node; a Git Bash /d/... path in NODE_OPTIONS is
// not a Windows filesystem path. The policy also reaches every forked worker.
execFileSync(process.execPath, [resolve('ci/current-source-mirror.mjs')], {
  env: {
    ...process.env,
    NODE_OPTIONS: `--require ${JSON.stringify(resolve('first-ci/deny-symlink.cjs'))}`,
  },
  stdio: 'inherit',
});
