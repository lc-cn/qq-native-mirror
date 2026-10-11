import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { QQClient } from '../src/index.ts';

class ControlledWorker extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  requests: Record<string, unknown>[] = [];
  send(value: Record<string, unknown>, callback: (error: Error | null) => void) {
    this.requests.push(value);
    callback(null);
    queueMicrotask(() => {
      this.emit('message', { id: value.id, result: undefined });
      if (value.method === 'close') {
        this.connected = false;
        this.exitCode = 0;
        this.emit('exit', 0, null);
      }
    });
  }
  kill() {
    this.connected = false;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }
}
function fixture() {
  const worker = new ControlledWorker();
  const client = new QQClient(worker as unknown as ChildProcess, 500);
  worker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_self' } });
  return { worker, client };
}
const invalidCases = [
  ['getUserProfile', ['bad']],
  ['setFriendRemark', ['123', 1]],
  ['deleteFriend', ['123', { block: 'yes' }]],
  ['setGroupName', ['123', ' ']],
  ['setGroupRemark', ['0', '']],
  ['setGroupMute', ['123', 1]],
  ['setGroupMemberMute', ['123', '456', -1]],
  ['setGroupMemberCard', ['123', 'bad', '']],
  ['setGroupAdmin', ['123', '456', 'yes']],
  ['kickGroupMember', ['123', '456', { rejectRejoin: 'yes' }]],
  ['leaveGroup', ['bad']],
] as const;
for (const [method, args] of invalidCases) {
  test(`${method}: invalid JavaScript input rejects before IPC`, async () => {
    const f = fixture();
    try {
      await assert.rejects(async () => Reflect.apply(f.client[method], f.client, args));
      assert.equal(f.worker.requests.length, 0);
    } finally {
      await f.client.close();
    }
  });
}
for (const method of ['deleteFriend', 'kickGroupMember'] as const) {
  for (const mode of ['changing', 'throw', 'close', 'defaults'] as const) {
    test(`${method}: public options capture ${mode}`, async () => {
      const f = fixture();
      const original = Error('options getter original');
      let reads = 0;
      let secondaryReads = 0;
      let closing: Promise<void> | undefined;
      const key = method === 'deleteFriend' ? 'block' : 'rejectRejoin';
      const secondaryKey = method === 'deleteFriend' ? 'both' : 'reason';
      const secondaryValue = method === 'deleteFriend' ? false : '';
      const options: Record<string, unknown> =
        mode === 'defaults'
          ? {}
          : {
              get [secondaryKey]() {
                secondaryReads++;
                return secondaryReads === 1 ? secondaryValue : 123;
              },
              get [key]() {
                reads++;
                if (mode === 'throw') throw original;
                if (mode === 'close') closing = f.client.close();
                return reads === 1 ? true : 'malicious';
              },
            };
      const invoke = () =>
        method === 'deleteFriend'
          ? f.client.deleteFriend('000123', options)
          : f.client.kickGroupMember('000123', '000456', options);
      try {
        if (mode === 'throw' || mode === 'close') {
          await assert.rejects(
            async () => invoke(),
            mode === 'throw' ? (error) => error === original : /closed|not online/i,
          );
          assert.equal(f.worker.requests.filter((r) => r.method === method).length, 0);
        } else {
          const pending = invoke();
          Object.defineProperty(options, key, { value: false, configurable: true });
          Object.defineProperty(options, secondaryKey, {
            value: method === 'deleteFriend' ? true : 'changed',
            configurable: true,
          });
          await pending;
          const sent = f.worker.requests.find((r) => r.method === method);
          assert.ok(sent);
          assert.notEqual(sent.options, options);
          assert.deepEqual(
            sent.options,
            method === 'deleteFriend'
              ? { block: mode === 'changing', both: false }
              : { rejectRejoin: mode === 'changing', reason: '' },
          );
          assert.equal(reads, mode === 'defaults' ? 0 : 1);
          assert.equal(secondaryReads, mode === 'defaults' ? 0 : 1);
        }
      } finally {
        await closing;
        await f.client.close();
      }
    });
  }
}
for (const id of ['0', '000123', '18446744073709551616']) {
  test(`legacy digit spelling ${id} survives public management IPC`, async () => {
    const f = fixture();
    try {
      await f.client.getUserProfile(id);
      await f.client.setFriendRemark(id, '');
      await f.client.setGroupName(id, 'name');
      await f.client.setGroupMute(id, false);
      await f.client.setGroupMemberMute(id, id, 0);
      await f.client.setGroupMemberCard(id, id, '');
      await f.client.setGroupAdmin(id, id, false);
      await f.client.leaveGroup(id);
      for (const sent of f.worker.requests) {
        if ('groupId' in sent) assert.equal(sent.groupId, id);
        if ('userId' in sent) assert.equal(sent.userId, id);
      }
    } finally {
      await f.client.close();
    }
  });
}
