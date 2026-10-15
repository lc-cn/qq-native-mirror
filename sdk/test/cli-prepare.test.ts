import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runClientCommand, type ClientCommandContext } from '../src/cli/client-command.ts';
import { isEntryCommand, validateCommandFlags } from '../src/cli/command-plan.ts';
import type { QQClient } from '../src/index.ts';

function fixture() {
  const signals = new EventEmitter();
  const outputs: string[] = [];
  const codes: number[] = [];
  const calls: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    state: 'idle',
    nativeExports: ['Session', 'Engine'],
    async login() {
      calls.push('login');
      assert.fail('prepare must never log in');
    },
    async close() {
      calls.push('close');
    },
  });
  const context: ClientCommandContext = {
    client: async () => {
      calls.push('create');
      return client as unknown as QQClient;
    },
    command: 'prepare',
    login: { method: 'restore' },
    autoReconnect: false,
    qrPath: '/unused.png',
    async writeQr() {
      assert.fail('prepare must never save a login QR');
    },
    output: (line) => outputs.push(line),
    report: () => assert.fail('prepare must never report account events'),
    signals,
    setExitCode: (code) => codes.push(code),
  };
  return { context, client, signals, outputs, codes, calls };
}

function released(f: ReturnType<typeof fixture>, closes = 1) {
  assert.equal(f.calls.filter((call) => call === 'close').length, closes);
  assert.equal(f.calls.includes('login'), false);
  assert.deepEqual(f.client.eventNames(), []);
  assert.deepEqual(f.signals.eventNames(), []);
}

test('prepare accepts only config before client acquisition', () => {
  assert.equal(isEntryCommand('prepare'), true);
  validateCommandFlags('prepare', { config: 'config.json' });
  for (const flag of ['uin', 'method', 'qr-file', 'events', 'unknown'])
    assert.throws(
      () => validateCommandFlags('prepare', { config: 'config.json', [flag]: 'unused' }),
      new RegExp(`Unknown option for prepare: --${flag}`),
    );
});

test('prepare reports observed loading fields and closes once without login or action', async () => {
  const f = fixture();
  f.context.action = async () => assert.fail('prepare has no account action');
  await runClientCommand(f.context);
  assert.deepEqual(f.calls, ['create', 'close']);
  assert.deepEqual(
    f.outputs.map((line) => JSON.parse(line)),
    [{ state: 'idle', nativeExports: ['Session', 'Engine'], nativeExportCount: 2 }],
  );
  assert.deepEqual(f.codes, []);
  released(f);
});

test('prepare preserves acquisition failure without fabricating a client or output', async () => {
  const f = fixture();
  const failure = new Error('prepare acquisition failed');
  f.context.client = async () => {
    throw failure;
  };
  await assert.rejects(runClientCommand(f.context), (error) => error === failure);
  assert.deepEqual(f.outputs, []);
  released(f, 0);
});

test('prepare output failure still closes once and keeps the original error', async () => {
  const f = fixture();
  const failure = new Error('prepare output failed');
  f.context.output = () => {
    throw failure;
  };
  await assert.rejects(runClientCommand(f.context), (error) => error === failure);
  released(f);
});

test('prepare close failure remains a failure and close is not retried', async () => {
  const f = fixture();
  const failure = new Error('prepare close failed');
  f.client.close = async () => {
    f.calls.push('close');
    throw failure;
  };
  await assert.rejects(runClientCommand(f.context), (error) => error === failure);
  assert.equal(f.outputs.length, 1);
  released(f);
});

test('prepare keeps existing cleanup error precedence when output and close both fail', async () => {
  const f = fixture();
  const closeFailure = new Error('prepare close failed');
  f.context.output = () => {
    throw new Error('prepare output failed');
  };
  f.client.close = async () => {
    f.calls.push('close');
    throw closeFailure;
  };
  await assert.rejects(runClientCommand(f.context), (error) => error === closeFailure);
  released(f);
});

test('signal before acquisition skips the factory and removes its signal listeners', async () => {
  const f = fixture();
  f.context.signals = {
    once(event, listener) {
      f.signals.once(event, listener);
      if (event === 'SIGINT') f.signals.emit(event);
    },
    removeListener: f.signals.removeListener.bind(f.signals),
  };
  await runClientCommand(f.context);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.outputs, []);
  assert.ok(f.codes.length > 0 && f.codes.every((code) => code === 130));
  released(f, 0);
});

test('signal during preparation waits for a late client and closes it once without output', async () => {
  const f = fixture();
  let complete!: (client: QQClient) => void;
  f.context.client = () => new Promise((resolve) => (complete = resolve));
  const pending = runClientCommand(f.context);
  f.signals.emit('SIGINT');
  f.signals.emit('SIGTERM');
  assert.deepEqual(f.calls, []);
  complete(f.client as unknown as QQClient);
  await pending;
  assert.deepEqual(f.outputs, []);
  assert.ok(f.codes.length > 0 && f.codes.every((code) => code === 130));
  released(f);
});

test('signal during preparation observes a late acquisition rejection and retains interrupt status', async () => {
  const f = fixture();
  const failure = new Error('late initialization failure');
  let reject!: (error: Error) => void;
  f.context.client = () => new Promise((_resolve, fail) => (reject = fail));
  const pending = runClientCommand(f.context);
  const failed = assert.rejects(pending, (error) => error === failure);
  f.signals.emit('SIGINT');
  reject(failure);
  await failed;
  assert.deepEqual(f.outputs, []);
  assert.ok(f.codes.length > 0 && f.codes.every((code) => code === 130));
  released(f, 0);
});

test('signal after preparation shares pending close instead of closing twice', async () => {
  const f = fixture();
  let complete!: () => void;
  let started!: () => void;
  const closing = new Promise<void>((resolve) => (started = resolve));
  f.client.close = () => {
    f.calls.push('close');
    started();
    return new Promise<void>((resolve) => (complete = resolve));
  };
  // The output occurs before finally removes signal listeners, as on the CLI.
  f.context.output = (line) => {
    f.outputs.push(line);
    f.signals.emit('SIGINT');
  };
  const pending = runClientCommand(f.context);
  await closing;
  f.signals.emit('SIGTERM');
  complete();
  await pending;
  assert.equal(f.outputs.length, 1);
  assert.ok(f.codes.length > 0 && f.codes.every((code) => code === 130));
  released(f);
});

test('signal converts a synchronous close throw into one cached cleanup failure', async () => {
  const f = fixture();
  const failure = new Error('synchronous close failure');
  f.client.close = () => {
    f.calls.push('close');
    throw failure;
  };
  f.context.output = () => {
    assert.doesNotThrow(() => f.signals.emit('SIGINT'));
    assert.doesNotThrow(() => f.signals.emit('SIGTERM'));
  };
  await assert.rejects(runClientCommand(f.context), (error) => error === failure);
  assert.ok(f.codes.length > 0 && f.codes.every((code) => code === 130));
  released(f);
});

test('runner aborts the independent creation signal and observes factory cancellation', async () => {
  const f = fixture();
  let captured!: AbortSignal;
  f.context.client = (signal) => {
    captured = signal;
    assert.equal(signal.aborted, false);
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const pending = runClientCommand(f.context);
  const rejected = assert.rejects(pending, (error) => error === captured.reason);
  f.signals.emit('SIGINT');
  await rejected;
  assert.equal(captured.aborted, true);
  assert.deepEqual(f.outputs, []);
  assert.ok(f.codes.length > 0 && f.codes.every((code) => code === 130));
  released(f, 0);
});

test('runner aborts creation before closing a client already acquired', async () => {
  const f = fixture();
  f.context.client = async (signal) => {
    signal.addEventListener('abort', () => f.calls.push('abort'), { once: true });
    return f.client as unknown as QQClient;
  };
  f.context.output = () => f.signals.emit('SIGINT');
  await runClientCommand(f.context);
  assert.deepEqual(f.calls, ['abort', 'close']);
  released(f);
});
