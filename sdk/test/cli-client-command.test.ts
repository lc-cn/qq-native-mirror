import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runClientCommand, type ClientCommandContext } from '../src/cli/client-command.ts';
import type { QQClient } from '../src/index.ts';

const account = { uin: '123', uid: 'u_fixture', nickname: 'fixture' };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(overrides: Partial<ClientCommandContext> = {}) {
  const events = new EventEmitter();
  const signals = new EventEmitter();
  const outputs: string[] = [];
  const reports: string[] = [];
  const writes: Buffer[] = [];
  const exitCodes: number[] = [];
  let closeCount = 0;
  const client = Object.assign(events, {
    login: async () => account,
    close: async () => {
      closeCount++;
    },
  });
  const context: ClientCommandContext = {
    client: client as unknown as QQClient,
    command: 'login',
    login: { method: 'restore' },
    autoReconnect: false,
    qrPath: '/fixture/qr.png',
    writeQr: async (_path, image) => {
      writes.push(image);
    },
    output: (line) => outputs.push(line),
    report: (line) => reports.push(line),
    signals,
    setExitCode: (code) => exitCodes.push(code),
    ...overrides,
  };
  return {
    client,
    signals,
    outputs,
    reports,
    writes,
    exitCodes,
    context,
    get closeCount() {
      return closeCount;
    },
  };
}

function assertReleased(f: ReturnType<typeof fixture>) {
  assert.equal(f.closeCount, 1);
  assert.deepEqual(f.client.eventNames(), []);
  assert.deepEqual(f.signals.eventNames(), []);
}

test('failed earlier QR save does not poison a later image, and login waits for the latest save', async () => {
  const f = fixture();
  const first = Buffer.from('first');
  const second = Buffer.from('second');
  f.client.login = async () => {
    f.client.emit('qrcode', { image: first });
    f.client.emit('qrcode', { image: second });
    return account;
  };
  f.context.writeQr = async (_path, image) => {
    f.writes.push(image);
    if (image === first) throw new Error('fixture write failure');
  };
  await runClientCommand(f.context);
  assert.deepEqual(f.writes, [first, second]);
  assert.equal(f.reports.filter((line) => /Cannot save/.test(line)).length, 1);
  assert.deepEqual(f.outputs, [JSON.stringify(account)]);
  assertReleased(f);
});

test('latest QR save failure rejects without printing login success and releases every listener', async () => {
  const f = fixture();
  const failure = new Error('fixture latest QR write failed');
  f.client.login = async () => {
    f.client.emit('qrcode', { image: Buffer.from('last') });
    return account;
  };
  f.context.writeQr = async () => {
    throw failure;
  };
  await assert.rejects(runClientCommand(f.context), (error) => error === failure);
  assert.equal(f.outputs.length, 0);
  assert.equal(f.reports.length, 1);
  assertReleased(f);
});

test('watch captures synchronous readiness events and an early terminal failure before login resolves', async () => {
  const f = fixture({ command: 'watch', watchMode: 'normalized' });
  f.client.login = async () => {
    f.client.emit('message', { messageId: '1' });
    f.client.emit('kicked');
    return account;
  };
  await assert.rejects(runClientCommand(f.context), /kicked offline/);
  assert.deepEqual(
    f.outputs.map((line) => JSON.parse(line)),
    [{ event: 'message', payload: { messageId: '1' } }],
  );
  assertReleased(f);
});

test('signals retire the client once and suppress an action after a late login completion', async () => {
  const f = fixture({ command: 'contacts' });
  let complete!: (value: typeof account) => void;
  f.client.login = () => new Promise((resolve) => (complete = resolve));
  let dispatched = false;
  f.context.action = async () => {
    dispatched = true;
  };
  const pending = runClientCommand(f.context);
  f.signals.emit('SIGINT');
  f.signals.emit('SIGTERM');
  complete(account);
  await pending;
  assert.equal(dispatched, false);
  assert.equal(f.outputs.length, 0);
  assert.ok(f.exitCodes.length > 0 && f.exitCodes.every((code) => code === 130));
  assertReleased(f);
});

test('login failure closes immediately and queued QR images never start after shutdown', async () => {
  const f = fixture();
  const failure = new Error('fixture login failed');
  let finishWrite!: () => void;
  f.context.writeQr = (_path, image) => {
    f.writes.push(image);
    return new Promise<void>((resolve) => (finishWrite = resolve));
  };
  f.client.login = async () => {
    f.client.emit('qrcode', { image: Buffer.from('running') });
    f.client.emit('qrcode', { image: Buffer.from('queued') });
    throw failure;
  };
  await assert.rejects(runClientCommand(f.context), (error) => error === failure);
  assert.equal(f.writes.length, 1);
  finishWrite();
  await tick();
  assert.equal(f.writes.length, 1);
  assert.equal(f.reports.length, 0);
  assertReleased(f);
});

test('invalid watch setup unwinds installed listeners and closes without login', async () => {
  const f = fixture({ command: 'watch', watchMode: 'invalid' });
  let loggedIn = false;
  f.client.login = async () => {
    loggedIn = true;
    return account;
  };
  await assert.rejects(runClientCommand(f.context), /--events/);
  assert.equal(loggedIn, false);
  assertReleased(f);
});

test('fallible signal cleanup still removes the other signal and closes the client', async () => {
  const f = fixture();
  const failure = new Error('fixture signal cleanup failed');
  const remove = f.signals.removeListener.bind(f.signals);
  f.context.signals = {
    once: f.signals.once.bind(f.signals),
    removeListener(event, listener) {
      remove(event, listener);
      if (event === 'SIGINT') throw failure;
    },
  };
  await assert.rejects(runClientCommand(f.context), (error) => error === failure);
  assertReleased(f);
});

test('prepared action runs once after login and keeps void-dispatch and JSON formatting', async () => {
  const f = fixture({ command: 'nickname' });
  const calls: string[] = [];
  f.client.login = async () => {
    calls.push('login');
    return account;
  };
  f.context.action = async (client) => {
    assert.equal(client, f.client);
    calls.push('action');
  };
  await runClientCommand(f.context);
  assert.deepEqual(calls, ['login', 'action']);
  assert.deepEqual(f.outputs, [JSON.stringify({ dispatched: true }, null, 2)]);
  assertReleased(f);
});

test('signal during an already dispatched action suppresses its late output without replay', async () => {
  const f = fixture({ command: 'contacts' });
  let complete!: (value: unknown) => void;
  let calls = 0;
  f.context.action = () => {
    calls++;
    return new Promise((resolve) => (complete = resolve));
  };
  const pending = runClientCommand(f.context);
  await tick();
  f.signals.emit('SIGINT');
  complete([{ userId: '123' }]);
  await pending;
  assert.equal(calls, 1);
  assert.equal(f.outputs.length, 0);
  assertReleased(f);
});
