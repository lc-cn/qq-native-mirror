import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only the SDK-generated output adjacent to this script's package root is removed.
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (manifest.name !== 'qq-native-client') throw new Error('Unexpected clean-dist package root');
const output = join(root, 'dist');
if (dirname(output) !== root) throw new Error('Invalid generated output directory');
try {
  const stat = await lstat(output);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('Generated output must be a regular directory');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await rm(output, { recursive: true, force: true });
