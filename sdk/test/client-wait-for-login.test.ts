import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { QQClient } from '../src/index.ts';

class Worker extends EventEmitter {
  connected = true;
  autoExitAfterClose = true;
  exitCode: number | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  requests: { id: number; method: string; login?: unknown }[] = [];
  send(
    value: { id: number; method: string; login?: unknown },
    callback: (error: Error | null) => void,
  ) {
    this.requests.push(value);
    callback(null);
    if (value.method === 'close')
      queueMicrotask(() => {
        this.emit('message', { id: value.id, result: null });
        setImmediate(() => {
          if (!this.autoExitAfterClose) return;
          this.connected = false;
          this.exitCode = 0;
          this.emit('exit', 0, null);
        });
      });
  }
  kill() {
    this.connected = false;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }
}

test('waitForLogin returns fresh online identity after a caller mutates the completed login result', async () => {
  const worker = new Worker(),
    client = new QQClient(worker as unknown as ChildProcess, 500);
  try {
    const login = client.login({ method: 'restore', uin: '123' });
    assert.equal(
      client.waitForLogin(),
      login,
      'pending custom login is joined without issuing default QR',
    );
    const account = { uin: '123', uid: 'u_original' };
    worker.emit('message', { event: 'ready', payload: account });
    worker.emit('message', { id: worker.requests[0].id, result: account });
    const first = await login;
    first.uin = '456';
    first.uid = 'u_mutated';
    const waited = await client.waitForLogin();
    assert.deepEqual(waited, { uin: '123', uid: 'u_original' });
    waited.uid = 'u_second_mutation';
    assert.deepEqual(await client.waitForLogin(), { uin: '123', uid: 'u_original' });
    assert.deepEqual(await client.login({ method: 'restore', uin: '123' }), {
      uin: '123',
      uid: 'u_original',
    });
    assert.equal(worker.requests.length, 1, 'online identity reads never dispatch another login');
  } finally {
    await client.close();
  }
  await assert.rejects(client.waitForLogin(), /closed/);
});

test('waitForLogin observes current account independently of a different default login target', async () => {
  const worker = new Worker(),
    client = new QQClient(worker as unknown as ChildProcess, 500, {
      method: 'restore',
      uin: '123',
    });
  try {
    worker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_current' } });
    assert.deepEqual(await client.waitForLogin(), { uin: '456', uid: 'u_current' });
    assert.equal(worker.requests.length, 0);
    await assert.rejects(client.login(), /different account/);
  } finally {
    await client.close();
  }
});
