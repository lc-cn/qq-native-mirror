import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createImageElement, createReplyElement, decodeElements } from '../src/message-elements.ts';

test('local PNG staging follows native allocation contract and preserves original', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-image-'));
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZSMAAAAASUVORK5CYII=', 'base64');
  const source = join(dir, 'original.png');
  const destination = join(dir, 'native', 'image.png');
  await writeFile(source, image);
  try {
    const result = await createImageElement(source, { getRichMediaFilePathForGuild(options: unknown) {
      assert.deepEqual(options, { md5HexStr: createHash('md5').update(image).digest('hex'), fileName: 'original.png', elementType: 2, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: '' });
      return destination;
    } });
    assert.equal(result.picElement.sourcePath, destination);
    assert.equal(result.picElement.picWidth, 1);
    assert.equal(result.picElement.picHeight, 1);
    assert.equal(result.picElement.picType, 1000);
    assert.equal(result.picElement.fileSize, String(image.length));
    assert.deepEqual(await readFile(destination), image);
    assert.deepEqual(await readFile(source), image);
  } finally { await rm(dir, { recursive: true }); }
});

test('URLs and nonimage files never invoke native allocation', async () => {
  let called = false;
  const service = { getRichMediaFilePathForGuild() { called = true; } };
  await assert.rejects(createImageElement('https://example.test/image.png', service), /absolute local/);
  const dir = await mkdtemp(join(tmpdir(), 'qq-image-invalid-'));
  try {
    const file = join(dir, 'text.png'); await writeFile(file, 'not an image');
    await assert.rejects(createImageElement(file, service), /Image format unsupported/);
    assert.equal(called, false);
  } finally { await rm(dir, { recursive: true }); }
});

test('reply uses fetched native identity and rejects nonexistent conversation message', async () => {
  const peer = { chatType: 2, peerUid: '123' };
  const service = { getMsgsByMsgId(p: unknown, ids: unknown) { assert.deepEqual(p, peer); assert.deepEqual(ids, ['9']); return { msgList: [{ msgId: '9', msgSeq: '4', senderUin: '456', clientSeq: '3' }] }; } };
  assert.deepEqual(await createReplyElement('9', peer, service), { elementType: 7, elementId: '', replyElement: { replayMsgSeq: '4', replayMsgId: '9', senderUin: '456', senderUinStr: '456', replyMsgClientSeq: '3', _replyMsgPeer: peer } });
  await assert.rejects(createReplyElement('10', peer, { getMsgsByMsgId: () => ({ msgList: [] }) }), /not found/);
});

test('inbound decode preserves all media and unknown element payloads', () => {
  const native = [{ elementType: 6, faceElement: { faceIndex: 1 } }, { elementType: 7, replyElement: { replayMsgId: '9' } }, { elementType: 2, picElement: { filePath: '/tmp/x.png' } }, { elementType: 4, pttElement: { fileUuid: 'opaque' } }, { elementType: 3, fileElement: { fileName: 'attachment' } }];
  const result = decodeElements(native);
  assert.deepEqual(result.slice(0, 3), [{ type: 'face', id: 1 }, { type: 'reply', messageId: '9' }, { type: 'image', file: '/tmp/x.png' }]);
  assert.deepEqual(result[3], { type: 'unknown', nativeType: 4, data: native[3] });
  assert.deepEqual(result[4], { type: 'unknown', nativeType: 3, data: native[4] });
  assert.equal(result.length, native.length);
});

test('file element references nonempty local attachment using native send pipeline fields', async () => {
  const { createFileElement } = await import('../src/message-elements.ts');
  const dir = await mkdtemp(join(tmpdir(), 'qq-file-'));
  const file = join(dir, 'input.txt'); await writeFile(file, 'hello');
  try {
    assert.deepEqual(await createFileElement(file, 'display.txt'), { elementType: 3, elementId: '', fileElement: { fileName: 'display.txt', folderId: '', filePath: file, fileSize: '5' } });
    await assert.rejects(createFileElement(file, '../escape.txt'), /filename/);
    await assert.rejects(createFileElement('https://example.test/file'), /absolute local/);
    assert.equal(await readFile(file, 'utf8'), 'hello');
  } finally { await rm(dir, { recursive: true }); }
});

test('inbound file video and record local paths retain element identifiers', () => {
  assert.deepEqual(decodeElements([
    { elementType: 3, elementId: '1', fileElement: { filePath: '/tmp/a.txt', fileName: 'a.txt', fileSize: '5' } },
    { elementType: 5, elementId: '2', videoElement: { filePath: '/tmp/a.mp4' } },
    { elementType: 4, elementId: '3', pttElement: { filePath: '/tmp/a.silk' } },
  ]), [
    { type: 'file', file: '/tmp/a.txt', elementId: '1', name: 'a.txt', size: '5' },
    { type: 'video', file: '/tmp/a.mp4', elementId: '2' },
    { type: 'record', file: '/tmp/a.silk', elementId: '3' },
  ]);
});
