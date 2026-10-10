import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createImageElement,
  createReplyElement,
} from '../src/features/messages/outbound-elements.ts';

test('local PNG staging follows native allocation contract and preserves original', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-image-'));
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZSMAAAAASUVORK5CYII=',
    'base64',
  );
  const source = join(dir, 'original.png');
  const destination = join(dir, 'native', 'image.png');
  await writeFile(source, image);
  try {
    const result = await createImageElement(source, {
      getRichMediaFilePathForGuild(options: unknown) {
        assert.deepEqual(options, {
          md5HexStr: createHash('md5').update(image).digest('hex'),
          fileName: 'original.png',
          elementType: 2,
          elementSubType: 0,
          thumbSize: 0,
          needCreate: true,
          downloadType: 1,
          file_uuid: '',
        });
        return destination;
      },
    });
    assert.equal(result.picElement.sourcePath, destination);
    assert.equal(result.picElement.picWidth, 1);
    assert.equal(result.picElement.picHeight, 1);
    assert.equal(result.picElement.picType, 1000);
    assert.equal(result.picElement.fileSize, String(image.length));
    assert.deepEqual(await readFile(destination), image);
    assert.deepEqual(await readFile(source), image);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('URLs and nonimage files never invoke native allocation', async () => {
  let called = false;
  const service = {
    getRichMediaFilePathForGuild() {
      called = true;
    },
  };
  await assert.rejects(
    createImageElement('https://example.test/image.png', service),
    /absolute local/,
  );
  const dir = await mkdtemp(join(tmpdir(), 'qq-image-invalid-'));
  try {
    const file = join(dir, 'text.png');
    await writeFile(file, 'not an image');
    await assert.rejects(createImageElement(file, service), /Image format unsupported/);
    assert.equal(called, false);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('reply uses fetched native identity and rejects nonexistent conversation message', async () => {
  const peer = { chatType: 2 as const, peerUid: '123' };
  const service = {
    getMsgsByMsgId(p: unknown, ids: unknown) {
      assert.deepEqual(p, peer);
      assert.deepEqual(ids, ['9']);
      return {
        result: 0,
        msgList: [
          { msgId: '9', msgSeq: '4', senderUin: '456', clientSeq: '3', ...peer, elements: [] },
        ],
      };
    },
  };
  assert.deepEqual(await createReplyElement('9', peer, service), {
    elementType: 7,
    elementId: '',
    replyElement: {
      replayMsgSeq: '4',
      replayMsgId: '9',
      senderUin: '456',
      senderUinStr: '456',
      replyMsgClientSeq: '3',
      _replyMsgPeer: peer,
    },
  });
  await assert.rejects(
    createReplyElement('10', peer, { getMsgsByMsgId: () => ({ result: 0, msgList: [] }) }),
    /not found/,
  );
});

test('reply rejects native query failure and wrong-conversation records before constructing a reference', async () => {
  const peer = { chatType: 2 as const, peerUid: '123' };
  await assert.rejects(
    createReplyElement('9', peer, {
      getMsgsByMsgId: () => ({ result: 23, msgList: [{ msgId: '9' }] }),
    }),
    { code: 23 },
  );
  await assert.rejects(
    createReplyElement('9', peer, {
      getMsgsByMsgId: () => ({
        result: 0,
        msgList: [{ msgId: '9', chatType: 2, peerUid: '456', elements: [] }],
      }),
    }),
    /mismatched/,
  );
});

test('reply never constructs native references with malformed sequence or sender metadata', async () => {
  const peer = { chatType: 2 as const, peerUid: '123' };
  const raw = { msgId: '9', msgSeq: '4', senderUin: '456', clientSeq: '3', ...peer, elements: [] };
  for (const field of ['msgSeq', 'senderUin', 'clientSeq']) {
    for (const value of [undefined, null, {}, false, [], 123, '']) {
      await assert.rejects(
        createReplyElement('9', peer, {
          getMsgsByMsgId: () => ({ result: 0, msgList: [{ ...raw, [field]: value }] }),
        }),
        new RegExp(field),
      );
    }
  }
});

test('file element references nonempty local attachment using native send pipeline fields', async () => {
  const { createFileElement } = await import('../src/features/messages/outbound-elements.ts');
  const dir = await mkdtemp(join(tmpdir(), 'qq-file-'));
  const file = join(dir, 'input.txt');
  await writeFile(file, 'hello');
  try {
    assert.deepEqual(await createFileElement(file, 'display.txt'), {
      elementType: 3,
      elementId: '',
      fileElement: { fileName: 'display.txt', folderId: '', filePath: file, fileSize: '5' },
    });
    await assert.rejects(createFileElement(file, '../escape.txt'), /filename/);
    await assert.rejects(createFileElement('https://example.test/file'), /absolute local/);
    assert.equal(await readFile(file, 'utf8'), 'hello');
  } finally {
    await rm(dir, { recursive: true });
  }
});
