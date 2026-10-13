import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

/** Preserve public coverage; current source additionally checks proposed closures.
 * @param {string|undefined} sourceMode
 */
export function linuxVersionMatrix(sourceMode) {
  assert.ok(
    typeof sourceMode === 'string' && ['current-source', 'published-baseline'].includes(sourceMode),
    'Invalid SDK source mode',
  );
  const include = [];
  for (const version of ['3.2.31-51102', '3.2.32-52194']) {
    for (const arch of ['x64', 'arm64']) {
      include.push({
        version,
        arch,
        runner: arch === 'x64' ? 'ubuntu-24.04' : 'ubuntu-24.04-arm',
        catalog: 'public-default',
      });
    }
  }
  if (sourceMode === 'current-source') {
    for (const arch of ['x64', 'arm64']) {
      include.push({
        version: '3.2.31-51102',
        arch,
        runner: arch === 'x64' ? 'ubuntu-24.04' : 'ubuntu-24.04-arm',
        catalog: 'legacy-bridge-candidate',
      });
    }
  }
  return { include };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`matrix=${JSON.stringify(linuxVersionMatrix(process.env.SDK_SOURCE_MODE))}`);
}
