import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { downloadAttachment } from '../src/features/media/attachment-downloads.ts';
import type { AttachmentDownloadPort } from '../src/runtime/media-contracts.ts';
import { createNativeEventChannel } from '../src/runtime/native-event-channel.ts';

for (const mode of ['sync', 'async', 'rejected', 'closed'] as const) {
  test(`download port preserves getter timing, receiver and completion ordering: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'download-port-'));
    const destination = join(directory, 'nested', 'output');
    const controller = new AbortController();
    const channel = createNativeEventChannel(controller.signal);
    let notifyInvocation!: () => void;
    const invoked = new Promise<void>((resolve) => {
      notifyInvocation = resolve;
    });
    let finish!: (value: unknown) => void, fail!: (reason: unknown) => void;
    const completion = new Promise<unknown>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // The synchronous case does not use the deferred native return.
    if (mode === 'sync') finish(undefined);
    let reads = 0,
      calls = 0;
    const peer = { chatType: 2, peerUid: '123' };
    const failure = Object.assign(new Error('native return failed'), { code: 'fixture' });
    const service: AttachmentDownloadPort = {
      get downloadRichMedia() {
        reads++;
        assert.equal(reads, 1);
        assert.equal(existsSync(dirname(destination)), false, 'Method capture precedes FS IO');
        return function (
          this: AttachmentDownloadPort,
          request: Parameters<NonNullable<AttachmentDownloadPort['downloadRichMedia']>>[0],
        ) {
          assert.equal(this, service);
          calls++;
          assert.deepEqual(request, {
            fileModelId: '0',
            downSourceType: 0,
            downloadSourceType: 0,
            triggerType: 1,
            msgId: '0009',
            chatType: 2,
            peerUid: '123',
            elementId: '02',
            thumbSize: 0,
            downloadType: 1,
            filePath: request.filePath,
          });
          assert.notEqual(request.filePath, destination);
          assert.equal(dirname(dirname(request.filePath)), dirname(destination));
          writeFileSync(request.filePath, 'fixture attachment');
          channel.dispatch('Msg/onRichMediaDownloadComplete', [
            {
              msgId: '0009',
              msgElementId: '02',
              fileErrCode: '0',
              fileSrvErrCode: 0,
              chatType: 2,
              filePath: request.filePath,
            },
          ]);
          notifyInvocation();
          return mode === 'sync' ? { result: 0 } : completion;
        };
      },
    };
    try {
      const pending = downloadAttachment(
        service,
        peer,
        { messageId: '0009', elementId: '02', destination },
        channel.call,
        controller.signal,
      );
      // Input capture remains synchronous, before the filesystem yields.
      peer.chatType = 1;
      peer.peerUid = 'changed';
      const observed = pending.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await Promise.race([
        invoked,
        observed.then((outcome) => {
          if (!outcome.ok) throw outcome.error;
          throw new Error('Download completed before its native invocation');
        }),
      ]);
      if (mode !== 'sync') {
        let settled = false;
        const settledObservation = observed.then(() => {
          settled = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(settled, false, 'A successful callback cannot outrun the native return');
        assert.equal(existsSync(destination), false);
        if (mode === 'closed') channel.close();
        else if (mode === 'rejected') fail(failure);
        else finish({ result: 0 });
        await settledObservation;
      }
      const result = await observed;
      if (mode === 'rejected') {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error, failure);
      } else if (mode === 'closed') {
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(String(result.error), /closed/i);
        // A late rejection is observed rather than replaying or publishing.
        fail(failure);
        await new Promise<void>((resolve) => setImmediate(resolve));
      } else {
        assert.deepEqual(result, { ok: true, value: { file: destination } });
        assert.equal(await readFile(destination, 'utf8'), 'fixture attachment');
      }
      assert.equal(reads, 1);
      assert.equal(calls, 1);
      assert.deepEqual(await readdir(dirname(destination)), result.ok ? ['output'] : []);
    } finally {
      channel.close();
      finish(undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
