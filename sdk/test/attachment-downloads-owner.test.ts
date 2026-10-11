import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, writeFileSync, chmodSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import {
  createAttachmentDownloads,
  type AttachmentDownloadsContext,
} from '../src/features/media/attachment-downloads.ts';
import type { AttachmentDownloadPort } from '../src/runtime/media-contracts.ts';
import { createNativeEventChannel } from '../src/runtime/native-event-channel.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';

async function fixture(overrides: Partial<AttachmentDownloadsContext> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'qq-download-owner-'));
  const destination = join(directory, 'nested', 'output');
  const lifetime = new NativeServiceLifetime();
  const channel = createNativeEventChannel(lifetime.signal);
  const calls: string[] = [];
  const waits: Promise<unknown>[] = [];
  let invoke: (
    request: Parameters<NonNullable<AttachmentDownloadPort['downloadRichMedia']>>[0],
  ) => unknown = (request) => {
    writeFileSync(request.filePath, 'owned fixture');
    channel.dispatch('Msg/onRichMediaDownloadComplete', [
      {
        msgId: '9',
        msgElementId: '2',
        fileErrCode: 0,
        fileSrvErrCode: '0',
        chatType: 1,
        filePath: request.filePath,
      },
    ]);
    return { result: 0 };
  };
  const service: AttachmentDownloadPort = {
    downloadRichMedia(request) {
      assert.equal(this, service);
      calls.push('download');
      return invoke(request);
    },
  };
  const owner = createAttachmentDownloads({
    signal: lifetime.signal,
    resolvePeer: async (peer) => {
      calls.push('peer');
      assert.equal(peer.type, 'private');
      return { chatType: 1, peerUid: 'u_friend' };
    },
    awaitAlive(value, signal) {
      const pending = Promise.resolve(value);
      waits.push(pending);
      return lifetime.awaitAlive(pending, signal);
    },
    getMessageService: () => {
      calls.push('service');
      return service;
    },
    eventCall: channel.call,
    ...overrides,
  });
  return {
    directory,
    destination,
    lifetime,
    channel,
    owner,
    calls,
    waits,
    service,
    payload: {
      peer: { type: 'private', userId: '123' },
      messageId: '9',
      elementId: '2',
      destination,
    },
    setInvoke(fn: typeof invoke) {
      invoke = fn;
    },
    async cleanup() {
      owner.close();
      lifetime.close();
      channel.close();
      await Promise.allSettled(waits);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Fixture deadline reached')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('owner validates entire payload before peer/native acquisition or filesystem work', async () => {
  const f = await fixture();
  try {
    for (const payload of [
      null,
      {},
      { ...f.payload, messageId: false },
      { ...f.payload, elementId: 'invalid' },
      { ...f.payload, destination: 'relative' },
      { ...f.payload, peer: { type: 'private', userId: false } },
    ])
      await assert.rejects(f.owner.download(payload));
    assert.deepEqual(f.calls, []);
    assert.equal(existsSync(dirname(f.destination)), false);
  } finally {
    await f.cleanup();
  }
});

test('owner snapshots payload and peer before resolve, preserves original native receiver', async () => {
  let resolvePeer!: (peer: { chatType: 1; peerUid: string }) => void;
  const f = await fixture({
    resolvePeer: (peer) => {
      assert.deepEqual(peer, { type: 'private', userId: '123' });
      return new Promise((resolve) => {
        resolvePeer = resolve;
      });
    },
  });
  const pending = f.owner.download(f.payload);
  f.payload.messageId = '99';
  f.payload.elementId = '77';
  f.payload.destination = join(f.directory, 'changed');
  f.payload.peer.userId = '456';
  resolvePeer({ chatType: 1, peerUid: 'u_friend' });
  try {
    assert.deepEqual(await bounded(pending), { file: f.destination });
    assert.deepEqual(f.calls, ['service', 'download']);
    assert.equal(existsSync(join(f.directory, 'changed')), false);
  } finally {
    await f.cleanup();
  }
});

test('owner close cancels pending UID lookup without FS/native acquisition and observes late rejection', async () => {
  let rejectPeer!: (error: unknown) => void;
  const f = await fixture({
    resolvePeer: () =>
      new Promise((_, reject) => {
        rejectPeer = reject;
      }),
  });
  const pending = f.owner.download(f.payload);
  const rejected = assert.rejects(bounded(pending), /downloads are closed/);
  f.owner.close();
  await rejected;
  rejectPeer(new Error('late UID'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.deepEqual(f.calls, []);
    assert.equal(existsSync(dirname(f.destination)), false);
  } finally {
    await f.cleanup();
  }
});

for (const stage of ['service', 'method'] as const)
  test(`reentrant close in ${stage} acquisition prevents any download or FS work`, async () => {
    let reads = 0,
      writes = 0;
    const f = await fixture({
      getMessageService: () => {
        if (stage === 'service') f.owner.close();
        return {
          get downloadRichMedia() {
            reads++;
            f.owner.close();
            return () => {
              writes++;
            };
          },
        };
      },
    });
    try {
      await assert.rejects(bounded(f.owner.download(f.payload)), /downloads are closed/);
      assert.equal(reads, stage === 'service' ? 0 : 1);
      assert.equal(writes, 0);
      assert.equal(existsSync(dirname(f.destination)), false);
    } finally {
      await f.cleanup();
    }
  });

for (const service of [null, undefined, {}])
  test(`missing nullable download service rejects before FS: ${String(service)}`, async () => {
    const f = await fixture({ getMessageService: () => service });
    try {
      await assert.rejects(
        f.owner.download(f.payload),
        /Native service is missing downloadRichMedia/,
      );
      assert.equal(existsSync(dirname(f.destination)), false);
    } finally {
      await f.cleanup();
    }
  });

for (const phase of ['native', 'callback'] as const)
  test(`local close cancels pending ${phase} wait and leaves another shared-channel waiter live`, async () => {
    const f = await fixture();
    let started!: () => void, rejectNative!: (error: unknown) => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.setInvoke((request) => {
      writeFileSync(request.filePath, 'late fixture');
      if (phase === 'native')
        f.channel.dispatch('Msg/onRichMediaDownloadComplete', [
          {
            msgId: '9',
            msgElementId: '2',
            fileErrCode: 0,
            fileSrvErrCode: 0,
            filePath: request.filePath,
          },
        ]);
      started();
      return phase === 'native'
        ? new Promise((_, reject) => {
            rejectNative = reject;
          })
        : { result: 0 };
    });
    const other = f.channel.call(
      'Other/event',
      (value: string) => value,
      () => undefined,
    );
    other.catch(() => {});
    const pending = f.owner.download(f.payload);
    const rejection = assert.rejects(bounded(pending), /downloads are closed/);
    try {
      await bounded(dispatched);
      f.owner.close();
      await rejection;
      if (phase === 'native') rejectNative(new Error('late native reject'));
      else
        f.channel.dispatch('Msg/onRichMediaDownloadComplete', [
          {
            msgId: '9',
            msgElementId: '2',
            fileErrCode: 0,
            fileSrvErrCode: 0,
            filePath: f.destination,
          },
        ]);
      f.channel.dispatch('Other/event', ['still live']);
      assert.equal(await bounded(other), 'still live');
      assert.equal(f.waits.length, 1, 'Only peer resolution uses the injected cancellable wait');
      assert.deepEqual(await readdir(dirname(f.destination)), []);
      assert.equal(existsSync(f.destination), false);
      assert.equal(f.calls.filter((value) => value === 'download').length, 1);
    } finally {
      await f.cleanup();
    }
  });

test('already-cancelled request rejects before peer/native/FS and does not retire the owner', async () => {
  const f = await fixture();
  const request = new AbortController();
  const error = new Error('request cancelled');
  request.abort(error);
  try {
    await assert.rejects(
      f.owner.download(f.payload, request.signal),
      (actual: unknown) => actual === error,
    );
    assert.deepEqual(f.calls, []);
    assert.equal(existsSync(dirname(f.destination)), false);
    assert.deepEqual(await bounded(f.owner.download(f.payload)), { file: f.destination });
  } finally {
    await f.cleanup();
  }
});

test('request cancellation during UID lookup observes late failure and next request remains usable', async () => {
  let rejectPeer!: (error: unknown) => void,
    lookups = 0;
  const f = await fixture({
    resolvePeer: async () => {
      lookups++;
      if (lookups === 1)
        return new Promise((_, reject) => {
          rejectPeer = reject;
        });
      return { chatType: 1, peerUid: 'u_friend' };
    },
  });
  const request = new AbortController();
  const error = new Error('request UID cancelled');
  const pending = f.owner.download(f.payload, request.signal);
  const rejection = assert.rejects(bounded(pending), (actual: unknown) => actual === error);
  try {
    request.abort(error);
    await rejection;
    assert.deepEqual(f.calls, []);
    assert.equal(existsSync(dirname(f.destination)), false);
    rejectPeer(new Error('late peer failure'));
    assert.deepEqual(await bounded(f.owner.download(f.payload)), { file: f.destination });
    assert.equal(lookups, 2);
  } finally {
    await f.cleanup();
  }
});

for (const phase of ['native', 'callback'] as const)
  test(`request cancellation during ${phase} wait isolates sibling and observes late work`, async () => {
    const f = await fixture();
    const request = new AbortController();
    const error = new Error('request download cancelled');
    let started!: () => void, rejectNative!: (error: unknown) => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.setInvoke((options) => {
      writeFileSync(options.filePath, 'cancelled content');
      if (phase === 'native')
        f.channel.dispatch('Msg/onRichMediaDownloadComplete', [
          {
            msgId: '9',
            msgElementId: '2',
            fileErrCode: 0,
            fileSrvErrCode: 0,
            filePath: options.filePath,
          },
        ]);
      started();
      return phase === 'native'
        ? new Promise((_, reject) => {
            rejectNative = reject;
          })
        : { result: 0 };
    });
    const pending = f.owner.download(f.payload, request.signal);
    const rejection = assert.rejects(bounded(pending), (actual: unknown) => actual === error);
    try {
      await bounded(dispatched);
      request.abort(error);
      await rejection;
      assert.equal(f.waits.length, 1);
      assert.equal(existsSync(f.destination), false);
      if (phase === 'native') rejectNative(new Error('late native failure'));
      else
        f.channel.dispatch('Msg/onRichMediaDownloadComplete', [
          {
            msgId: '9',
            msgElementId: '2',
            fileErrCode: 0,
            fileSrvErrCode: 0,
            filePath: f.destination,
          },
        ]);
      f.setInvoke((options) => {
        writeFileSync(options.filePath, 'sibling content');
        f.channel.dispatch('Msg/onRichMediaDownloadComplete', [
          {
            msgId: '9',
            msgElementId: '2',
            fileErrCode: 0,
            fileSrvErrCode: 0,
            filePath: options.filePath,
          },
        ]);
        return { result: 0 };
      });
      assert.deepEqual(await bounded(f.owner.download(f.payload)), { file: f.destination });
      assert.equal(f.calls.filter((value) => value === 'download').length, 2);
    } finally {
      await f.cleanup();
    }
  });

test('real staging cleanup permission failure retains the primary native error', async () => {
  const f = await fixture();
  const primary = new Error('primary native download failure');
  f.setInvoke((request) => {
    chmodSync(dirname(dirname(request.filePath)), 0o500);
    throw primary;
  });
  try {
    const outcome = await f.owner.download(f.payload).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.ok(outcome.error instanceof AggregateError);
      assert.equal(outcome.error.errors[0], primary);
      const cleanup: unknown = outcome.error.errors[1];
      assert.ok(cleanup instanceof Error && 'code' in cleanup && cleanup.code === 'EACCES');
    }
    assert.equal(f.calls.filter((value) => value === 'download').length, 1);
  } finally {
    chmodSync(dirname(f.destination), 0o700);
    await f.cleanup();
  }
});

for (const primary of [undefined, new Error('native primary')] as const)
  test(`cleanup preserves a thrown primary including undefined; aggregate on both failures`, async () => {
    const f = await fixture();
    const cleanup = new Error('controlled staging cleanup failure');
    const originalRm = fsPromises.rm;
    let attempts = 0;
    fsPromises.rm = async (path, options) => {
      if (typeof path === 'string' && basename(path).startsWith('.qq-download-')) {
        attempts++;
        throw cleanup;
      }
      return originalRm(path, options);
    };
    syncBuiltinESMExports();
    f.setInvoke(() => {
      throw primary;
    });
    try {
      const outcome = await f.owner.download(f.payload).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.ok(outcome.error instanceof AggregateError);
        assert.equal(outcome.error.errors[0], primary);
        assert.equal(outcome.error.errors[1], cleanup);
      }
      assert.equal(attempts, 1);
    } finally {
      fsPromises.rm = originalRm;
      syncBuiltinESMExports();
      await f.cleanup();
    }
  });

test('cleanup-only failure keeps its exact identity and does not delete or retry published output', async () => {
  const f = await fixture();
  const cleanup = new Error('cleanup only');
  const originalRm = fsPromises.rm;
  let attempts = 0;
  fsPromises.rm = async (path, options) => {
    if (typeof path === 'string' && basename(path).startsWith('.qq-download-')) {
      attempts++;
      throw cleanup;
    }
    return originalRm(path, options);
  };
  syncBuiltinESMExports();
  try {
    const outcome = await f.owner.download(f.payload).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error, cleanup);
    assert.equal(attempts, 1);
    assert.equal(await readFile(f.destination, 'utf8'), 'owned fixture');
    assert.equal(f.calls.filter((value) => value === 'download').length, 1);
  } finally {
    fsPromises.rm = originalRm;
    syncBuiltinESMExports();
    await f.cleanup();
  }
});

test('successful staging cleanup preserves a thrown undefined primary', async () => {
  const f = await fixture();
  f.setInvoke(() => {
    throw undefined;
  });
  try {
    const outcome = await f.owner.download(f.payload).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error, undefined);
    assert.deepEqual(await readdir(dirname(f.destination)), []);
  } finally {
    await f.cleanup();
  }
});

for (const cancellation of ['close', 'request'] as const)
  test(`${cancellation} waits for actual staging cleanup before the owner result settles`, async () => {
    const f = await fixture();
    const request = new AbortController();
    let started!: () => void, rejectNative!: (error: unknown) => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cleanupStarted!: () => void, releaseCleanup!: () => void;
    const cleaning = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const originalRm = fsPromises.rm;
    fsPromises.rm = async (path, options) => {
      if (typeof path === 'string' && basename(path).startsWith('.qq-download-')) {
        cleanupStarted();
        await released;
      }
      return originalRm(path, options);
    };
    syncBuiltinESMExports();
    f.setInvoke((options) => {
      writeFileSync(options.filePath, 'native staged file');
      started();
      return new Promise((_, reject) => {
        rejectNative = reject;
      });
    });
    let settled = false;
    const pending = f.owner.download(f.payload, request.signal);
    const observed = pending.then(
      (value) => {
        settled = true;
        return { ok: true as const, value };
      },
      (error: unknown) => {
        settled = true;
        return { ok: false as const, error };
      },
    );
    try {
      await bounded(dispatched);
      if (cancellation === 'close') f.owner.close();
      else request.abort(new Error('request cleanup cancelled'));
      await bounded(cleaning);
      await Promise.resolve();
      assert.equal(settled, false, 'Owner cannot finish before staging cleanup finishes');
      releaseCleanup();
      const outcome = await bounded(observed);
      assert.equal(outcome.ok, false);
      // Check immediately after owner rejection, without another scheduling/drain step.
      assert.deepEqual(await readdir(dirname(f.destination)), []);
      assert.equal(existsSync(f.destination), false);
      rejectNative(new Error('late observed native failure'));
      assert.equal(f.calls.filter((value) => value === 'download').length, 1);
    } finally {
      releaseCleanup();
      fsPromises.rm = originalRm;
      syncBuiltinESMExports();
      await observed;
      await f.cleanup();
    }
  });
