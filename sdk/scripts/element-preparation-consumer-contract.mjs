import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

/** Installed pure projection/local preparation contracts; no native loading or send. */
export async function verifyElementPreparationConsumer(packageRoot) {
  const { decodeElements } = await import(
    pathToFileURL(join(packageRoot, 'dist/features/messages/inbound-elements.js')).href
  );
  const { createImageElement, createFileElement, createReplyElement } = await import(
    pathToFileURL(join(packageRoot, 'dist/features/messages/outbound-elements.js')).href
  );
  const root = await mkdtemp(join(tmpdir(), 'qq-element-consumer-'));
  try {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZSMAAAAASUVORK5CYII=',
      'base64',
    );
    const image = join(root, 'source.png'),
      staged = join(root, 'cache', 'staged.png');
    const attachment = join(root, 'original.txt');
    await writeFile(image, bytes);
    await writeFile(attachment, 'original attachment');
    let allocations = 0;
    const allocator = {
      getRichMediaFilePathForGuild(request) {
        assert.equal(this, allocator);
        allocations++;
        assert.deepEqual(request, {
          md5HexStr: createHash('md5').update(bytes).digest('hex'),
          fileName: 'source.png',
          elementType: 2,
          elementSubType: 0,
          thumbSize: 0,
          needCreate: true,
          downloadType: 1,
          file_uuid: '',
        });
        return staged;
      },
    };
    const prepared = await createImageElement(image, allocator);
    assert.equal(prepared.elementType, 2);
    assert.equal(prepared.picElement.sourcePath, staged);
    assert.equal(prepared.picElement.picWidth, 1);
    assert.equal(prepared.picElement.picHeight, 1);
    assert.deepEqual(await readFile(staged), bytes);
    assert.deepEqual(await readFile(image), bytes);
    await assert.rejects(
      createImageElement('https://invalid.test/image.png', allocator),
      /absolute local/,
    );
    await assert.rejects(createImageElement(attachment, allocator), /format unsupported/);
    assert.equal(allocations, 1);
    const file = await createFileElement(attachment, ' renamed.txt');
    assert.deepEqual(file, {
      elementType: 3,
      elementId: '',
      fileElement: { fileName: ' renamed.txt', folderId: '', filePath: attachment, fileSize: '19' },
    });
    assert.equal(await readFile(attachment, 'utf8'), 'original attachment');
    await assert.rejects(createFileElement(attachment, '../invalid'));
    const peer = { chatType: 2, peerUid: '123' },
      messageId = '18446744073709551615';
    let queries = 0;
    const service = {
      getMsgsByMsgId(actualPeer, ids) {
        assert.equal(this, service);
        queries++;
        assert.deepEqual(actualPeer, peer);
        assert.deepEqual(ids, [messageId]);
        return {
          result: 0,
          msgList: [
            {
              ...peer,
              msgId: messageId,
              msgSeq: '9007199254740993',
              clientSeq: '3',
              senderUin: '456',
              elements: [],
            },
          ],
        };
      },
    };
    const reply = await createReplyElement(messageId, peer, service);
    assert.deepEqual(reply, {
      elementType: 7,
      elementId: '',
      replyElement: {
        replayMsgId: messageId,
        replayMsgSeq: '9007199254740993',
        senderUin: '456',
        senderUinStr: '456',
        replyMsgClientSeq: '3',
        _replyMsgPeer: peer,
      },
    });
    assert.equal(queries, 1);
    await assert.rejects(
      createReplyElement(messageId, peer, {
        getMsgsByMsgId: () => ({ result: 0, msgList: [{ ...peer, msgId: '9', elements: [] }] }),
      }),
    );
    await assert.rejects(
      createReplyElement(messageId, peer, { getMsgsByMsgId: () => ({ result: 0, msgList: [] }) }),
      /not found/,
    );
    const opaque = { elementType: 999, elementId: 'opaque', privateField: { preserved: true } };
    const decoded = decodeElements([{ elementType: 1, textElement: { content: 'first' } }, opaque]);
    assert.deepEqual(decoded[0], { type: 'text', text: 'first' });
    assert.equal(decoded[1].type, 'unknown');
    assert.equal(decoded[1].data, opaque);
    assert.deepEqual(opaque.privateField, { preserved: true });
    return {
      elementPreparationInstalledContract: true,
      elementPreparationReceiverContract: true,
      elementPreparationSourcePreservationContract: true,
      elementPreparationReplyCorrelationContract: true,
      elementPreparationUnknownIdentityContract: true,
      nativeElementPreparationAttempted: false,
      accountUsed: false,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
