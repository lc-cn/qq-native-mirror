import assert from 'node:assert/strict';
import { ChildProcess, type Serializable } from 'node:child_process';
import test from 'node:test';
import { QQClient } from '../src/index.ts';
import type { GroupMember, GroupMemberQueryOptions } from '../src/index.ts';
import { createNativeServices } from '../src/native-services.ts';
import { isServiceOperation } from '../src/runtime/operations.ts';

const account = { uin: '123', uid: 'u_self' };
const member: GroupMember = {
  userId: '0009007199254740993',
  uid: 'u_member',
  nickname: 'member',
  card: 'group card',
  role: 'admin',
};

class Worker extends ChildProcess {
  readonly requests: Record<string, unknown>[] = [];
  hold = false;
  failure?: { message: string; code: number };
  constructor() {
    super();
    Object.defineProperty(this, 'connected', { value: true, configurable: true });
  }
  override send(value: Serializable, ...args: unknown[]): boolean {
    if (!value || typeof value !== 'object') throw Error('Invalid fixture command');
    const command = value as Record<string, unknown>;
    this.requests.push(command);
    const callback = args.find((arg) => typeof arg === 'function');
    if (typeof callback === 'function') Reflect.apply(callback, undefined, [null]);
    if (!this.hold || command.method === 'close') queueMicrotask(() => this.respond(command));
    return true;
  }
  respond(command: Record<string, unknown>, result?: unknown): void {
    this.emit(
      'message',
      this.failure
        ? { id: command.id, error: this.failure }
        : {
            id: command.id,
            result: result ?? (command.method === 'getGroupMembers' ? [member] : member),
          },
    );
    if (command.method === 'close') this.exit();
  }
  ready(value = account): void {
    this.emit('message', { event: 'ready', payload: value });
  }
  offline(): void {
    this.emit('message', {
      event: 'disconnected',
      payload: { source: 'login', kind: 'transport', retryable: false, args: [] },
    });
  }
  exit(): void {
    Object.defineProperty(this, 'connected', { value: false, configurable: true });
    Object.defineProperty(this, 'exitCode', { value: 0, configurable: true });
    this.emit('exit', 0, null);
  }
  override kill(): boolean {
    this.exit();
    return true;
  }
}
function fixture() {
  const worker = new Worker();
  const client = new QQClient(worker, 500, { method: 'quick', uin: account.uin }, undefined, false);
  worker.ready();
  const group = client.pickGroup('000456');
  const selected = group.pickMember(member.userId);
  const readers = [
    (options?: GroupMemberQueryOptions) => client.getGroupMembers(group.groupId, options),
    (options?: GroupMemberQueryOptions) =>
      client.getGroupMember(group.groupId, member.userId, options),
    (options?: GroupMemberQueryOptions) => group.getMembers(options),
    (options?: GroupMemberQueryOptions) => selected.getInfo(options),
  ];
  return { client, worker, group, selected, readers };
}
function commands(worker: Worker) {
  return worker.requests.map(({ id: _id, ...command }) => command);
}

test('client and contact member readers preserve absent options and flatten explicit refresh', async (t) => {
  const f = fixture();
  t.after(() => f.client.close());
  for (const options of [
    undefined,
    {},
    { refresh: undefined },
    { refresh: false },
    { refresh: true },
  ]) {
    for (let index = 0; index < f.readers.length; index++) {
      assert.deepEqual(await f.readers[index](options), index % 2 === 0 ? [member] : member);
      assert.deepEqual(commands(f.worker).at(-1), {
        method: index % 2 === 0 ? 'getGroupMembers' : 'getGroupMember',
        groupId: '000456',
        ...(index % 2 === 1 ? { userId: member.userId } : {}),
        ...(options?.refresh === undefined ? {} : { refresh: options.refresh }),
      });
    }
  }
  const options = { refresh: true };
  const pending = f.selected.getInfo(options);
  options.refresh = false;
  assert.deepEqual(commands(f.worker).at(-1), {
    method: 'getGroupMember',
    groupId: '000456',
    userId: member.userId,
    refresh: true,
  });
  await pending;
});

test('client and contact member readers reject accessors before IPC without evaluating them', async (t) => {
  const f = fixture();
  t.after(() => f.client.close());
  let reads = 0;
  const options = {
    get refresh(): boolean {
      reads++;
      throw new Error('getter details');
    },
  };
  for (const read of f.readers) await assert.rejects(read(options), /data property/);
  for (const value of ['', '0', '000', 'u_member', '1.2', '-1']) {
    await assert.rejects(f.client.getGroupMember('456', value));
    await assert.rejects(f.client.getGroupMember(value, '123'));
  }
  assert.equal(reads, 0);
  assert.deepEqual(f.worker.requests, []);
});

test('capture reentrancy cannot redirect any member reader into the next account', async (t) => {
  for (let index = 0; index < 4; index++) {
    for (const throws of [false, true]) {
      const f = fixture();
      t.after(() => f.client.close());
      let captures = 0;
      const options = new Proxy(
        { refresh: true },
        {
          getOwnPropertyDescriptor(target, key) {
            captures++;
            f.worker.offline();
            f.worker.ready({ uin: '789', uid: 'u_next' });
            if (throws) throw new Error('trap details');
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        },
      );
      await assert.rejects(f.readers[index](options), /inactive or replaced/);
      assert.equal(captures, 1);
      assert.deepEqual(f.worker.requests, []);
      await f.client.getGroupMember('456', member.userId);
      assert.equal(f.worker.requests.length, 1);
    }
  }
});

test('duplicate ready retains member handles, but a real offline retires old readers', async (t) => {
  const f = fixture();
  t.after(() => f.client.close());
  f.worker.ready({ ...account });
  assert.deepEqual(await f.selected.getInfo(), member);
  assert.deepEqual(await f.group.getMembers(), [member]);
  f.worker.offline();
  f.worker.ready({ ...account });
  await assert.rejects(f.selected.getInfo(), /inactive or replaced/);
  await assert.rejects(f.group.getMembers(), /inactive or replaced/);
  assert.equal(f.worker.requests.length, 2);
  assert.deepEqual(await f.client.pickMember('456', member.userId).getInfo(), member);
});

test('successful response queued just before retirement is never exposed to the caller', async (t) => {
  for (let index = 0; index < 4; index++) {
    const f = fixture();
    t.after(() => f.client.close());
    f.worker.hold = true;
    const pending = f.readers[index]();
    const rejected = assert.rejects(pending, /inactive or replaced/);
    f.worker.respond(f.worker.requests[0]);
    f.worker.offline();
    f.worker.ready({ uin: '789', uid: 'u_next' });
    await rejected;
    assert.equal(f.worker.requests.length, 1);
  }
});

test('read errors retain native codes and are not retried or rewritten by later retirement', async (t) => {
  for (let index = 0; index < 4; index++) {
    const f = fixture();
    t.after(() => f.client.close());
    f.worker.hold = true;
    f.worker.failure = { message: 'native member query failed', code: 17 };
    const rejected = assert.rejects(f.readers[index](), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(Reflect.get(error, 'code'), 17);
      return true;
    });
    f.worker.respond(f.worker.requests[0]);
    f.worker.offline();
    await rejected;
    f.worker.failure = undefined;
    assert.equal(f.worker.requests.length, 1);
  }
});

test('registered member operation routes through the shared complete-list owner', async (t) => {
  const calls: unknown[][] = [];
  let acquired = 0;
  const group = {
    addKernelGroupListener() {},
    getAllMemberList(this: unknown, ...args: unknown[]) {
      assert.equal(this, group);
      calls.push(args);
      return {
        errCode: 0,
        result: {
          finish: true,
          infos: new Map([
            [
              member.uid,
              {
                uid: member.uid,
                uin: member.userId,
                nick: member.nickname,
                cardName: member.card,
                role: 3,
              },
            ],
          ]),
        },
      };
    },
  };
  const services = createNativeServices({
    session: {
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => {
        acquired++;
        return group;
      },
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
    },
    version: 'controlled',
    events: { emit() {} },
  });
  t.after(() => services.close());
  acquired = 0;
  assert.equal(isServiceOperation('getGroupMember'), true);
  await assert.rejects(
    services.invokeOperation('getGroupMember', { groupId: '456', userId: 'u_bad' }),
  );
  await assert.rejects(
    services.invokeOperation('getGroupMember', { groupId: '456', userId: '123', refresh: 'true' }),
  );
  assert.equal(acquired, 0);
  assert.deepEqual(
    await services.invokeOperation('getGroupMember', {
      groupId: '000456',
      userId: '9007199254740993',
      refresh: true,
    }),
    member,
  );
  assert.equal(
    await services.invokeOperation('getGroupMember', { groupId: '456', userId: '789' }),
    undefined,
  );
  assert.deepEqual(calls, [
    ['000456', true],
    ['456', false],
  ]);
});
