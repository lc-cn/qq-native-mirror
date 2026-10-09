import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepareNative } from '../src/native-package.ts';

// Only loads the addon and lists exports. Never initializes a session or logs in.
// A separate process is essential: native crashes cannot be caught by JS.
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/probe-native.ts [--runtime /path/to/runtime] [--electron-node] [--addon /path/to/wrapper.node] [--bridge /path/to/registration-bridge.node]');
  process.exit(0);
}
function value(flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} requires a path`);
  return resolve(args[index + 1]);
}
const runtime = value('--runtime', process.execPath);
const automatic = args.includes('--addon') ? undefined : await prepareNative({ dataDir: tmpdir() });
const addon = value('--addon', automatic?.wrapperPath ?? '');
const adjacent = resolve(dirname(addon), 'registration-bridge.node');
const fallbackBridge = fileURLToPath(new URL(`../native/${process.platform}-${process.arch}/registration-bridge.node`, import.meta.url));
const bridge = args.includes('--bridge') ? value('--bridge', '') : ['darwin', 'linux'].includes(process.platform)
  ? (existsSync(adjacent) ? adjacent : existsSync(fallbackBridge) ? fallbackBridge : undefined) : undefined;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (args.includes('--electron-node')) env.ELECTRON_RUN_AS_NODE = '1';
const source = `
console.log(JSON.stringify({stage:'runtime',versions:process.versions,arch:process.arch}));
try {
  if (${JSON.stringify(bridge)} !== undefined) {
    const flags = require('node:os').constants.dlopen;
    const bridgeModule = {exports:{}};
    process.dlopen(bridgeModule, ${JSON.stringify(bridge)}, flags.RTLD_NOW | flags.RTLD_GLOBAL);
    if (process.platform === 'linux') bridgeModule.exports.preloadLibrary?.('libgnutls.so.30');
  }
  const module = {exports:{}};
  process.dlopen(module, ${JSON.stringify(addon)});
  console.log(JSON.stringify({stage:'loaded',exports:Object.keys(module.exports)}));
  process.exit(0);
} catch (error) {
  console.error(JSON.stringify({stage:'load-error',message:error.message}));
  process.exit(1);
}`;
const result = spawnSync(runtime, ['-e', source], {
  env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, cwd: tmpdir(),
});
console.log(JSON.stringify({
  runtime, addon, status: result.status, signal: result.signal,
  error: result.error?.message, stdout: result.stdout, stderr: result.stderr,
}, null, 2));
process.exitCode = result.status === 0 && !result.signal && !result.error ? 0 : 1;
