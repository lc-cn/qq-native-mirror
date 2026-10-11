import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
const bin = dirname(process.execPath);
const cli = [
  process.env.npm_execpath,
  join(bin, 'node_modules/npm/bin/npm-cli.js'),
  join(bin, '../lib/node_modules/npm/bin/npm-cli.js'),
].find((p) => p && existsSync(p));
if (!cli) throw new Error('npm CLI unavailable for the selected Node runtime');
/** Selected Node executable and its npm CLI arguments; preserve the tuple. */
/** @type {[string, string[]]} */
export const npm = [process.execPath, [cli]];
