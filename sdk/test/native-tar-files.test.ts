import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readNativeTarFiles } from '../scripts/native-tar-files.mjs';
function entry(name: string, body = Buffer.alloc(0), type = '0', prefix = '') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.write(prefix, 345, 155);
  const checksum = [...header].reduce((a, b) => a + b, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
function pax(key: string, value: string) {
  const content = ` ${key}=${value}\n`;
  let length = content.length + 1;
  while (String(length).length + content.length !== length)
    length = String(length).length + content.length;
  return Buffer.from(String(length) + content);
}
async function fixture(t: any, bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'qq-tar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'package.tgz');
  await writeFile(file, gzipSync(bytes));
  return file;
}
const end = Buffer.alloc(1024);
test('single inflation yields multiple binary members, empty files and prefix paths', async (t) => {
  const path = await fixture(
    t,
    Buffer.concat([
      entry('package', undefined, '5'),
      entry('a', Buffer.from([0, 255, 1]), '0', 'package'),
      entry('package/b', Buffer.from('second')),
      entry('package/empty'),
      end,
    ]),
  );
  const files = await readNativeTarFiles(path);
  assert.deepEqual([...files.keys()], ['package/a', 'package/b', 'package/empty']);
  assert.deepEqual(files.get('package/a'), Buffer.from([0, 255, 1]));
  assert.equal(files.get('package/empty').length, 0);
  await assert.rejects(readNativeTarFiles(path, { maxMembers: 2 }), /limit/);
  await assert.rejects(readNativeTarFiles(path, { maxFileBytes: 2 }), /bound/);
});
test('PAX path and GNU longname safely override a following regular member', async (t) => {
  const long = 'package/' + 'long/'.repeat(24) + 'file';
  const path = await fixture(
    t,
    Buffer.concat([
      entry('PaxHeader', pax('path', long), 'x'),
      entry('package/short', Buffer.from('pax')),
      entry('././@LongLink', Buffer.from('package/gnulong\0'), 'L'),
      entry('package/short2', Buffer.from('gnu')),
      end,
    ]),
  );
  // GNU extension header itself uses conventional dot components but is not extracted.
  const files = await readNativeTarFiles(path);
  assert.equal(files.get(long).toString(), 'pax');
  assert.equal(files.get('package/gnulong').toString(), 'gnu');
});
test('checksum, truncation, duplicate paths, links and unsafe extensions reject', async (t) => {
  const corrupt = entry('package/a', Buffer.from('data'));
  corrupt[0] ^= 1;
  const values = [
    corrupt,
    entry('package/a', Buffer.from('data')).subarray(0, 513),
    Buffer.concat([entry('package/a'), entry('package/a'), end]),
    Buffer.concat([entry('package/a', undefined, '2'), end]),
    Buffer.concat([entry('package/a', undefined, '6'), end]),
    Buffer.concat([entry('Pax', pax('path', 'package/../escape'), 'x'), entry('package/a'), end]),
    Buffer.concat([entry('Pax', pax('path', 'package/valid'), 'g'), end]),
    Buffer.concat([entry('Pax', Buffer.from('999 path=package/a\n'), 'x'), end]),
    Buffer.concat([entry('package/a'), end, Buffer.from([1])]),
    Buffer.concat([entry('package/a'), Buffer.alloc(512)]),
  ];
  for (const bytes of values) {
    const path = await fixture(t, bytes);
    await assert.rejects(readNativeTarFiles(path));
  }
});
test('PAX decimal size and base256 numeric field preserve actual payload bounds', async (t) => {
  const extended = entry('Pax', pax('size', '3'), 'x');
  const regular = entry('package/data', Buffer.from('abc'));
  regular.fill(0, 124, 136);
  regular[124] = 128;
  regular[135] = 3;
  regular.fill(32, 148, 156);
  const sum = [...regular.subarray(0, 512)].reduce((a, b) => a + b, 0);
  regular.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const path = await fixture(t, Buffer.concat([extended, regular, end]));
  assert.equal((await readNativeTarFiles(path)).get('package/data').toString(), 'abc');
});
