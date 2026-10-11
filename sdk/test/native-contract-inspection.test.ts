import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectNativeContracts } from '../src/native/native-contract-inspection.ts';
import {
  hasNativeContractVersion,
  supportsCategoryCreation,
} from '../src/native/native-contracts.ts';

const clientVersion = {
  linux: '3.2.32-52194',
  darwin: '7.0.2-53644',
  win32: '9.9.33-52230',
}[process.platform as 'linux' | 'darwin' | 'win32'];

test('unknown native version metadata does not acquire a wrapper file', async () => {
  for (const version of [
    undefined,
    null,
    7,
    {},
    { clientVersion: 7 },
    { clientVersion: 'unknown' },
  ])
    assert.equal(await inspectNativeContracts('/missing-wrapper.node', version), undefined);
});

test('binary provenance measures bytes and host identity instead of trusting caller fields', async () => {
  assert.ok(clientVersion);
  assert.equal(hasNativeContractVersion(process.platform, process.arch, clientVersion), true);
  const directory = await mkdtemp(join(tmpdir(), 'qq-contract-inspection-'));
  const wrapper = join(directory, 'wrapper.node');
  const bytes = Buffer.from('Controlled provenance input; never loaded as an addon.');
  let versionReads = 0;
  try {
    await writeFile(wrapper, bytes);
    const profile = await inspectNativeContracts(wrapper, {
      get clientVersion() {
        versionReads++;
        return clientVersion;
      },
      platform: 'caller-platform',
      arch: 'caller-architecture',
      wrapperSha256: '7882b8e3055cd38584861042befacd8be9939896f5cbbca6fa4a230926b48526',
    });
    assert.deepEqual(profile, {
      platform: process.platform,
      arch: process.arch,
      clientVersion,
      wrapperSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    assert.equal(versionReads, 1);
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(supportsCategoryCreation(profile, clientVersion), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a known version retains file acquisition failures instead of inventing a profile', async () => {
  assert.ok(clientVersion);
  const directory = await mkdtemp(join(tmpdir(), 'qq-contract-inspection-'));
  try {
    await assert.rejects(
      inspectNativeContracts(join(directory, 'absent.node'), { clientVersion }),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
