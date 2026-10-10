import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createImageElement,
  createReplyElement,
} from '../src/features/messages/outbound-elements.ts';

test('image uses only staging port, two method reads, original receiver and exact request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-outbound-'));
  try {
    const file = join(root, 'a.png');
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.writeUInt32BE(2, 16);
    png.writeUInt32BE(3, 20);
    await writeFile(file, png);
    let reads = 0,
      calls = 0;
    const service = {
      get getRichMediaFilePathForGuild() {
        reads++;
        return function (this: unknown, request: unknown) {
          assert.equal(this, service);
          calls++;
          assert.deepEqual(request, {
            md5HexStr: '2d34e0877371e69ae1e4d6d66ef9354f',
            fileName: 'a.png',
            elementType: 2,
            elementSubType: 0,
            thumbSize: 0,
            needCreate: true,
            downloadType: 1,
            file_uuid: '',
          });
          return file;
        };
      },
    };
    const element = await createImageElement(file, service);
    assert.equal(reads, 2);
    assert.equal(calls, 1);
    assert.equal(element.picElement.sourcePath, file);
    assert.equal(element.picElement.picWidth, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('image rejects non-string or relative staging response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-outbound-'));
  try {
    const file = join(root, 'a.gif');
    await writeFile(file, Buffer.from('47494638396101000100', 'hex'));
    for (const value of [undefined, {}, 'relative'])
      await assert.rejects(
        createImageElement(file, { getRichMediaFilePathForGuild: () => value }),
        /Invalid native image staging path/,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reply uses ID query port receiver and peer, preserving exact reply fields', async () => {
  const peer = { chatType: 2 as const, peerUid: '123' };
  let reads = 0,
    calls = 0;
  const service = {
    get getMsgsByMsgId() {
      reads++;
      return function (this: unknown, actual: unknown, ids: unknown) {
        assert.equal(this, service);
        assert.equal(actual, peer);
        assert.deepEqual(ids, ['7']);
        calls++;
        return {
          result: 0,
          msgList: [
            {
              chatType: 2,
              peerUid: '123',
              msgId: '7',
              msgSeq: '8',
              senderUin: '9',
              clientSeq: '10',
              elements: [],
            },
          ],
        };
      };
    },
  };
  const result = await createReplyElement('7', peer, service);
  assert.equal(reads, 2);
  assert.equal(calls, 1);
  assert.deepEqual(result.replyElement, {
    replayMsgSeq: '8',
    replayMsgId: '7',
    senderUin: '9',
    senderUinStr: '9',
    replyMsgClientSeq: '10',
    _replyMsgPeer: peer,
  });
  assert.notEqual(result.replyElement._replyMsgPeer, peer);
});
