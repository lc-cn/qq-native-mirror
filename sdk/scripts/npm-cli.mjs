import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

// Run npm's JavaScript entry with the selected Node executable on every host.
// In particular, execFile must not try to launch a Windows .cmd shim.
const bin = dirname(process.execPath);
const cli = [
  process.env.npm_execpath,
  join(bin, 'node_modules/npm/bin/npm-cli.js'),
  join(bin, '../lib/node_modules/npm/bin/npm-cli.js'),
].find((path) => path && existsSync(path));
if (!cli) throw new Error('npm CLI unavailable for the selected Node runtime');

/** Selected Node executable and its npm CLI arguments; preserve the tuple. */
/** @type {[string, string[]]} */
export const npm = [process.execPath, [cli]];
