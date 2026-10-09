import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!['darwin', 'linux'].includes(process.platform)) {
  throw new Error(`Native registration bridge currently supports macOS and Linux; received ${process.platform}`);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.env.QQ_NODE_INCLUDE,
  resolve(dirname(process.execPath), '../include/node'),
  '/usr/include/node',
  '/usr/local/include/node',
  '/opt/homebrew/include/node',
].filter((path): path is string => Boolean(path));
const include = candidates.find((path) => existsSync(resolve(path, 'node_api.h')));
if (!include) throw new Error('Node C headers unavailable. Set QQ_NODE_INCLUDE to a directory containing node_api.h.');
const outputDir = resolve(root, 'native', `${process.platform}-${process.arch}`);
mkdirSync(outputDir, { recursive: true });
const output = resolve(outputDir, 'registration-bridge.node');
const compiler = process.env.QQ_CC ?? (process.platform === 'darwin' ? 'clang' : 'cc');
const linker = process.platform === 'darwin'
  ? ['-dynamiclib', '-undefined', 'dynamic_lookup', '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64']
  : ['-shared', '-fPIC'];
const result = spawnSync(compiler, [
  ...linker, `-I${include}`, resolve(root, 'native/registration-bridge.c'), ...(process.platform === 'linux' ? ['-ldl'] : []), '-o', output,
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Native bridge build failed with exit ${result.status}`);
console.log(`Built ${output}`);
