import { ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** One installed-package contract for local and platform CI; sends use a fake client.
 * @param {string} packageRoot
 */
export async function verifyFaceConsumer(packageRoot) {
  /** @type {Promise<typeof import('../src/cli.ts')>} */
  const cliModule = import(pathToFileURL(join(packageRoot, 'dist/cli.js')).href);
  const { normalizeMessage, prepareCommand } = await cliModule;
  /** @type {Promise<typeof import('../src/features/messages/face-input.ts')>} */
  const faceModule = import(
    pathToFileURL(join(packageRoot, 'dist/features/messages/face-input.js')).href
  );
  const { faceElement } = await faceModule;
  /** @type {Promise<typeof import('../src/index.ts')>} */
  const clientModule = import(pathToFileURL(join(packageRoot, 'dist/index.js')).href);
  const { QQClient } = await clientModule;
  const worker = new ChildProcess();
  // A genuine ChildProcess object with controlled IPC; no spawn/fork or QQ IO.
  Object.defineProperty(worker, 'connected', { value: true, configurable: true });
  Object.defineProperty(worker, 'send', {
    value(
      /** @type {{id:number,method:string}} */ message,
      /** @type {(error:Error|null)=>void} */ callback,
    ) {
      callback(null);
      if (message.method === 'close') {
        queueMicrotask(() => {
          worker.emit('message', { id: message.id, result: null });
          setImmediate(() => {
            Object.defineProperty(worker, 'connected', { value: false, configurable: true });
            Object.defineProperty(worker, 'exitCode', { value: 0, configurable: true });
            worker.emit('exit', 0, null);
          });
        });
      }
      return true;
    },
  });
  const root = await mkdtemp(join(tmpdir(), 'qq-face-consumer-'));
  const client = new QQClient(worker, 5000);
  try {
    /** @type {import('../src/contracts/messages.ts').SendableMessageElement[]} */
    const mixed = [{ type: 'text', text: 'fixture' }, ...[14, 333, 428].map((id) => faceInput(id))];
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
    /** @type {Parameters<import('../src/index.ts').QQClient['sendGroupMessage']>[]} */
    const calls = [];
    client.sendGroupMessage = async (...args) => {
      calls.push(args);
      return { messageId: '1', sequence: '1', time: 1 };
    };
    await action(client);
    assert.deepEqual(calls, [['123', mixed]]);
    return { faceContract: true, faceDeliveryAttempted: false };
  } finally {
    try {
      await client.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

/** @param {number} id @returns {import('../src/contracts/messages.ts').SendableMessageElement} */
function faceInput(id) {
  return { type: 'face', id };
}
