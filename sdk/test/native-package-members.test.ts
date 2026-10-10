import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readNativePackageMembers } from '../scripts/native-package-members.mjs';
function entry(name: string, body: Buffer) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  h.fill(32, 148, 156);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(
    [...h]
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
  );
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
test('drive/colon archive path uses filesystem parser without tar executable and captures only needed members once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-package-members-')),
    path = join(root, process.platform === 'win32' ? 'candidate.tgz' : 'C:windows-candidate.tgz');
  const originalPath = process.env.PATH;
  try {
    const manifest = Buffer.from(JSON.stringify({ videoCodec: 'custom/codec.node' }));
    await writeFile(
      path,
      gzipSync(
        Buffer.concat([
          entry('package/package.json', Buffer.from('{"name":"fixture"}')),
          entry('package/manifest.json', manifest),
          entry('package/custom/codec.node', Buffer.from('codec')),
          entry('package/video/SOURCE-PROVENANCE.json', Buffer.from('source')),
          entry('package/unused-large-vendor', Buffer.alloc(4096)),
          Buffer.alloc(1024),
        ]),
      ),
    );
    process.env.PATH = '';
    const cache = new Map(),
      first = await readNativePackageMembers(path, cache);
    assert.deepEqual(
      [...first.keys()],
      [
        'package/package.json',
        'package/manifest.json',
        'package/video/SOURCE-PROVENANCE.json',
        'package/custom/codec.node',
      ],
    );
    assert.equal(first.get('package/custom/codec.node').toString(), 'codec');
    await writeFile(path, 'corrupted after snapshot');
    assert.strictEqual(await readNativePackageMembers(path, cache), first);
    await assert.rejects(readNativePackageMembers(path));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});
