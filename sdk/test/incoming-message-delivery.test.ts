import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIncomingMessageDelivery } from '../src/features/messages/incoming-message-delivery.ts';
import { projectNativeMessage } from '../src/features/messages/inbound-messages.ts';
import { decodeElements } from '../src/features/messages/message-elements.ts';
import type { NativeObject } from '../src/native/native-object.ts';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const message = (id: string, lookup = false): NativeObject => ({
  chatType: 1,
  peerUid: 'u_peer',
  peerUin: lookup ? '0' : '123',
  senderUid: 'u_sender',
  senderUin: '456',
  sendNickName: 'fixture',
  msgId: id,
  msgSeq: id,
  msgTime: '100',
  elements: [{ elementType: 1, textElement: { atType: 0, content: `text${id}` } }],
});
function fixture() {
  const emitted: string[] = [];
  const diagnostics: string[] = [];
  const dispatches: NativeObject[][] = [];
  const pending: {
    messages: NativeObject[];
    raw: NativeObject[];
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];
  const project = (value: NativeObject, raw: NativeObject) =>
    projectNativeMessage(value, decodeElements(value.elements), new Map([['u_peer', '123']]), raw);
  const delivery = createIncomingMessageDelivery({
    project,
    emitMessage: (value) => emitted.push(value.messageId),
    diagnostic: (value) => diagnostics.push(value),
    dispatch: (value) => dispatches.push(value),
    resolveMessages: (messages, raw, signal) => {
      assert.equal(signal.aborted, false);
      if (!messages.length) return Promise.resolve([]);
      return new Promise((resolve, reject) =>
        pending.push({
          messages,
          raw,
          resolve: () => resolve(messages.map((value, i) => project(value, raw[i]))),
          reject,
        }),
      );
    },
  });
  return { delivery, emitted, diagnostics, dispatches, pending, project };
}
test('fast path delivers synchronously, ignores unsupported conversations and diagnoses invalid rows/batches', () => {
  const f = fixture();
  f.delivery.receive([message('1'), { chatType: 4 }, null]);
  assert.deepEqual(f.emitted, ['1']);
  assert.equal(f.pending.length, 0);
  assert.deepEqual(f.diagnostics, ['invalid-native-message']);
  f.delivery.receive(null);
  assert.equal(f.diagnostics[1], 'invalid-native-message-batch');
});
test('queued receipt snapshots survive raw mutation and preserve batch order behind deferred lookup', async () => {
  const f = fixture();
  const raw = message('1', true);
  f.delivery.receive([raw]);
  f.delivery.receive([message('2')]);
  raw.msgId = '99';
  raw.elements[0].textElement.content = 'mutated';
  await tick();
  assert.equal(f.pending.length, 1);
  assert.equal(f.pending[0].messages[0].msgId, '1');
  assert.equal(f.pending[0].messages[0].elements[0].textElement.content, 'text1');
  assert.equal(f.pending[0].raw[0], raw);
  f.pending[0].resolve();
  await tick();
  assert.deepEqual(f.emitted, ['1']);
  assert.equal(f.pending.length, 2);
  f.pending[1].resolve();
  await tick();
  assert.deepEqual(f.emitted, ['1', '2']);
});
test('duplicates are suppressed both before a queued lookup and within delivery', async () => {
  const f = fixture();
  f.delivery.receive([message('1', true), message('1', true)]);
  f.delivery.receive([message('1', true)]);
  await tick();
  f.pending[0].resolve();
  await tick();
  assert.deepEqual(f.emitted, ['1']);
  assert.equal(f.pending.length, 1);
});
test('close during lookup prevents delivery, dispatch and subsequent queued lookups', async () => {
  const f = fixture();
  f.delivery.receive([message('1', true)]);
  f.delivery.receive([message('2', true)]);
  await tick();
  f.delivery.close();
  f.pending[0].resolve();
  await tick();
  f.delivery.receive([message('3')]);
  assert.deepEqual(f.emitted, []);
  assert.deepEqual(f.dispatches, []);
  assert.equal(f.pending.length, 1);
});
test('failed resolution diagnoses once and does not block subsequent batch', async () => {
  const f = fixture();
  f.delivery.receive([message('1', true)]);
  f.delivery.receive([message('2')]);
  await tick();
  f.pending[0].reject(new Error('lookup failure'));
  await tick();
  assert.deepEqual(f.diagnostics, ['invalid-native-message']);
  f.pending[1].resolve();
  await tick();
  assert.deepEqual(f.emitted, ['2']);
});
test('reentrant close from first message stops following messages and dispatch', () => {
  const emitted: string[] = [];
  let dispatches = 0;
  const f = fixture();
  const delivery = createIncomingMessageDelivery({
    project: f.project,
    resolveMessages: async () => [],
    diagnostic() {},
    dispatch() {
      dispatches++;
    },
    emitMessage: (value) => {
      emitted.push(value.messageId);
      delivery.close();
    },
  });
  delivery.receive([message('1'), message('2')]);
  assert.deepEqual(emitted, ['1']);
  assert.equal(dispatches, 0);
});

test('close aborts its resolver signal while stalled provider remains unsettled and late rejection is handled', async () => {
  const signals: AbortSignal[] = [];
  let rejectProvider!: (error: Error) => void;
  let emitted = 0;
  let dispatched = 0;
  const f = fixture();
  const delivery = createIncomingMessageDelivery({
    project: f.project,
    emitMessage() {
      emitted++;
    },
    dispatch() {
      dispatched++;
    },
    diagnostic() {
      assert.fail('closed resolver must not diagnose');
    },
    resolveMessages(_messages, _raw, signal) {
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        rejectProvider = reject;
      });
    },
  });
  delivery.receive([message('1', true)]);
  delivery.receive([message('2', true)]);
  await tick();
  assert.equal(signals.length, 1);
  delivery.close();
  assert.equal(signals[0].aborted, true);
  await tick();
  await tick();
  assert.equal(signals.length, 1);
  assert.equal(emitted, 0);
  assert.equal(dispatched, 0);
  rejectProvider(new Error('late provider failure'));
  await tick();
  assert.equal(emitted, 0);
});

test('dedup evicts the oldest receipt at 10000 while retaining newer receipts', () => {
  const f = fixture();
  f.delivery.receive(Array.from({ length: 10001 }, (_, index) => message(String(index + 1))));
  assert.equal(f.emitted.length, 10001);
  f.delivery.receive([message('1'), message('2'), message('10001')]);
  assert.deepEqual(f.emitted.slice(10001), ['1']);
  f.delivery.receive([message('2')]);
  assert.deepEqual(f.emitted.slice(10001), ['1', '2']);
});
test('dispatch retains original raw rows including same-batch duplicates', async () => {
  const f = fixture();
  const raws = [message('1', true), message('1', true), message('2', true)];
  f.delivery.receive(raws);
  await tick();
  f.pending[0].resolve();
  await tick();
  assert.deepEqual(f.dispatches[0], raws);
  assert.equal(f.dispatches[0][0], raws[0]);
  assert.deepEqual(f.emitted, ['1', '2']);
  f.delivery.receive(raws);
  await tick();
  assert.deepEqual(f.dispatches[1], []);
});

test('an unresolved decoded row still reaches callback dispatch with its original raw object', async () => {
  const f = fixture();
  const dispatched: NativeObject[][] = [];
  const delivery = createIncomingMessageDelivery({
    project: f.project,
    resolveMessages: async () => [undefined],
    emitMessage() {
      assert.fail('unresolved row must not emit');
    },
    diagnostic() {},
    dispatch: (rows) => dispatched.push(rows),
  });
  const raw = message('1', true);
  delivery.receive([raw]);
  await tick();
  assert.equal(dispatched[0][0], raw);
});

test('dedup uses the same captured identity and never reads unrelated raw getters', () => {
  const f = fixture(),
    raw = message('1');
  let unrelatedReads = 0;
  Object.defineProperty(raw, 'unrelated', {
    enumerable: true,
    get() {
      unrelatedReads++;
      raw.msgId = '2';
      return null;
    },
  });
  f.delivery.receive([raw]);
  f.delivery.receive([message('1')]);
  f.delivery.receive([message('2')]);
  assert.deepEqual(f.emitted, ['1', '2']);
  assert.equal(unrelatedReads, 0);
  assert.deepEqual(f.diagnostics, []);
  f.delivery.close();
});

test('invalid captured receipt is diagnosed without emission or dispatching its raw row', () => {
  const f = fixture();
  f.delivery.receive([{ ...message('1'), msgId: 'invalid' }]);
  assert.deepEqual(f.emitted, []);
  assert.deepEqual(f.diagnostics, ['invalid-native-message']);
  assert.deepEqual(f.dispatches, [[]]);
  f.delivery.close();
});
