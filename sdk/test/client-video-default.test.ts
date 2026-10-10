import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createClient } from '../src/index.ts';

class FakeVideoWorker extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  requests: any[] = [];
  send(value: any, callback: (error: Error | null) => void) {
    this.requests.push(value);
    callback(null);
    queueMicrotask(() => {
      if (value.method === 'init')
        this.emit('message', { id: value.id, result: { exports: ['fake'] } });
      else if (value.method === 'login') {
        const account = { uin: '456', uid: 'u_fixture' };
        this.emit('message', { event: 'ready', payload: account });
        this.emit('message', { id: value.id, result: account });
      } else if (value.method === 'close') this.emit('message', { id: value.id, result: null });
    });
  }
  kill() {
    this.connected = false;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }
}

test('createClient preserves explicit codec/tools precedence over bundled codec on fake reconnect', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qq-video-client-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wrapperPath = join(root, 'wrapper.node'),
    discovered = join(root, 'discovered.node'),
    explicit = join(root, 'explicit-codec.mjs');
  const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
  await writeFile(wrapperPath, 'fake-wrapper');
  await writeFile(discovered, 'fake-discovered');
  await writeFile(explicit, 'export const getVideoInfo=()=>{};');
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'client-video',
      platform: process.platform,
      arch: process.arch,
      wrapper: 'wrapper.node',
      videoCodec: 'discovered.node',
      version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' },
      files: [
        { path: 'wrapper.node', sha256: hash('fake-wrapper') },
        { path: 'discovered.node', sha256: hash('fake-discovered') },
      ],
    }),
  );
  const workers: FakeVideoWorker[] = [],
    original = childProcess.fork;
  childProcess.fork = (() => {
    const worker = new FakeVideoWorker();
    workers.push(worker);
    return worker as unknown as ChildProcess;
  }) as typeof childProcess.fork;
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.fork = original;
    syncBuiltinESMExports();
  });
  const tools = { ffmpeg: join(root, 'explicit-ffmpeg'), ffprobe: join(root, 'explicit-ffprobe') };
  const cases = [
    {},
    { videoCodecPath: explicit },
    { mediaTools: tools },
    { videoCodecPath: explicit, mediaTools: tools },
  ];
  for (const options of cases) {
    const { videoCodecPath, mediaTools } = options;
    const before = workers.length;
    const client = await createClient({
      wrapperPath,
      dataDir: join(root, 'unused-' + before),
      videoCodecPath,
      mediaTools,
      autoReconnect: false,
      timeoutMs: 1000,
    });
    try {
      const expected = videoCodecPath ?? (mediaTools === undefined ? discovered : undefined);
      assert.equal(
        workers[before].requests.find((request) => request.method === 'init').options
          .videoCodecPath,
        expected,
      );
      assert.deepEqual(
        workers[before].requests.find((request) => request.method === 'init').options.mediaTools,
        mediaTools,
      );
      assert.equal(client.account, undefined);
      // A synthetic worker answers reconnect; no real authorization/native call occurs.
      await client.reconnect({ method: 'restore', uin: '456' });
      assert.equal(
        workers[before + 1].requests.find((request) => request.method === 'init').options
          .videoCodecPath,
        expected,
      );
      assert.equal(
        workers[before + 1].requests.filter((request) => request.method === 'login').length,
        1,
      );
    } finally {
      await client.close();
    }
  }
});
