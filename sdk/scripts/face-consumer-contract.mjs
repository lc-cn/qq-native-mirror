import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** One installed-package contract for local and platform CI; sends use a fake client. */
export async function verifyFaceConsumer(packageRoot) {
  const { normalizeMessage, prepareCommand } = await import(
    pathToFileURL(join(packageRoot, 'dist/cli.js')).href
  );
  const { faceElement } = await import(
    pathToFileURL(join(packageRoot, 'dist/features/messages/face-input.js')).href
  );
  const root = await mkdtemp(join(tmpdir(), 'qq-face-consumer-'));
  try {
    const mixed = [
      { type: 'text', text: 'fixture' },
      ...[14, 333, 428].map((id) => ({ type: 'face', id })),
    ];
    assert.deepEqual(normalizeMessage(mixed), mixed);
    assert.deepEqual(faceElement(428), {
      elementType: 6,
      elementId: '',
      faceElement: {
        faceIndex: 428,
        faceType: 2,
        faceText: '/收到',
        sourceType: 1,
        stickerType: 0,
        packId: '0',
        stickerId: '0',
      },
    });
    assert.throws(() => normalizeMessage([{ type: 'face', id: 99999 }]), /Unsupported QQ face/);
    const path = join(root, 'faces.json');
    await writeFile(path, JSON.stringify(mixed));
    const action = await prepareCommand('send', {
      kind: 'group',
      target: '123',
      'message-file': path,
    });
    const calls = [];
    await action({
      async sendGroupMessage(...args) {
        calls.push(args);
      },
    });
    assert.deepEqual(calls, [['123', mixed]]);
    return { faceContract: true, faceDeliveryAttempted: false };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
