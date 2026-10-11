import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { prepareCommand } from '../src/cli/command-plan.ts';
import { groupsCommands } from '../src/cli/commands/groups.ts';
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
  ['handleFriendRequest', [{ uid: '', time: '0' }, true]],
  ['handleFriendRequest', [{ uid: 'u_friend', time: 'bad' }, true]],
  ['handleFriendRequest', [{ uid: 'u_friend', time: '0' }, 1]],
  ['listGroupRequests', [{ before: '' }]],
  ['listGroupRequests', [{ before: null }]],
  ['listGroupRequests', [{ doubt: 'yes' }]],
  ['listGroupRequests', [{ limit: 101 }]],
  ['handleGroupRequest', [{ groupId: 'bad', sequence: '0', type: 7, doubt: false }, true]],
  ['handleGroupRequest', [{ groupId: '0', sequence: '0', type: 2, doubt: false }, true]],
  ['handleGroupRequest', [{ groupId: '0', sequence: '0', type: 7, doubt: 1 }, true]],
  ['handleGroupRequest', [{ groupId: '0', sequence: '0', type: 7, doubt: false }, true, 1]],
] as const;
for (const [method, args] of invalidCases) {
  test(`${method}: invalid request rejects without IPC ${JSON.stringify(args)}`, async () => {
    const f = fixture();
    try {
      await assert.rejects(async () => Reflect.apply(f.client[method], f.client, args));
      assert.equal(f.worker.requests.length, 0);
    } finally {
      await f.client.close();
    }
  });
}
const cases = [
  {
    method: 'handleFriendRequest',
    fields: { uid: 'u_friend', time: '0000' },
    invoke: (c: QQClient, v: Record<string, unknown>) =>
      Reflect.apply(c.handleFriendRequest, c, [v, true]),
    key: 'request',
  },
  {
    method: 'listGroupRequests',
    fields: { doubt: false, before: '0000', limit: 20 },
    invoke: (c: QQClient, v: Record<string, unknown>) => Reflect.apply(c.listGroupRequests, c, [v]),
    key: 'options',
  },
  {
    method: 'handleGroupRequest',
    fields: { groupId: '0', sequence: '0000', type: 7, doubt: false },
    invoke: (c: QQClient, v: Record<string, unknown>) =>
      Reflect.apply(c.handleGroupRequest, c, [v, false, '']),
    key: 'request',
  },
] as const;
for (const entry of cases) {
  for (const mode of ['changing', 'throw', 'close'] as const) {
    test(`${entry.method}: ${mode} captures selected fields once and ignores raw`, async () => {
      const f = fixture();
      const original = Error('request getter original');
      let closing: Promise<void> | undefined;
      const reads = new Map<string, number>();
      const input: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entry.fields)) {
        Object.defineProperty(input, key, {
          configurable: true,
          get() {
            const count = (reads.get(key) ?? 0) + 1;
            reads.set(key, count);
            if (mode === 'throw') throw original;
            if (mode === 'close') closing ??= f.client.close();
            return count === 1 ? value : { malicious: true };
          },
        });
      }
      Object.defineProperty(input, 'raw', {
        get() {
          assert.fail('raw must not be read');
        },
      });
      try {
        if (mode === 'changing') {
          const pending = entry.invoke(f.client, input);
          for (const key of Object.keys(entry.fields))
            Object.defineProperty(input, key, { value: 'mutated' });
          await pending;
          const sent = f.worker.requests.find((r) => r.method === entry.method);
          assert.ok(sent);
          assert.notEqual(sent[entry.key], input);
          assert.deepEqual(sent[entry.key], entry.fields);
          assert.deepEqual(
            [...reads.values()],
            Object.keys(entry.fields).map(() => 1),
          );
          if (entry.method === 'handleGroupRequest') assert.equal(sent.reason, '');
        } else {
          await assert.rejects(
            async () => entry.invoke(f.client, input),
            mode === 'throw' ? (error) => error === original : /closed|not online/i,
          );
          assert.equal(f.worker.requests.filter((r) => r.method === entry.method).length, 0);
        }
      } finally {
        await closing;
        await f.client.close();
      }
    });
  }
}
test('list defaults and null limit preserve omission of before at IPC', async () => {
  const f = fixture();
  try {
    await f.client.listGroupRequests();
    await Reflect.apply(f.client.listGroupRequests, f.client, [{ limit: null }]);
    for (const sent of f.worker.requests)
      assert.deepEqual(sent.options, { doubt: false, limit: 20 });
  } finally {
    await f.client.close();
  }
});
for (const reason of [undefined, '']) {
  test(`group request reason ${String(reason)} remains unmodified at IPC`, async () => {
    const f = fixture();
    try {
      await f.client.handleGroupRequest(
        { groupId: '0000', sequence: '0', type: 1, doubt: false },
        true,
        reason,
      );
      assert.equal(f.worker.requests[0].reason, reason);
    } finally {
      await f.client.close();
    }
  });
}
test('group-request CLI captures reason in both registry and domain prepared action', async () => {
  const f = fixture();
  const flags = {
    'group-id': '0000',
    sequence: '0',
    type: '7',
    accept: 'true',
    reason: 'captured',
  };
  try {
    const registry = await prepareCommand('group-request', flags);
    const domain = await groupsCommands['group-request'].prepare(flags);
    flags.reason = 'mutated';
    await registry(f.client);
    await domain(f.client);
    assert.deepEqual(
      f.worker.requests.map((r) => r.reason),
      ['captured', 'captured'],
    );
  } finally {
    await f.client.close();
  }
});
