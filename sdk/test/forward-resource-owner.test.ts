import assert from 'node:assert/strict';
import test from 'node:test';
import { createForwardResourceOwner } from '../src/features/forward/forward-resource-owner.ts';
import { MergedForwardError } from '../src/errors.ts';
import { ForwardResourceError } from '../src/features/forward/forward-resource-transport.ts';

function fixture(selfUid = 'u_self') {
  const controller = new AbortController();
  const cleanup: (() => void)[] = [];
  const order: string[] = [];
  const service = {
    sendSsoCmdReqByContend(command: string) {
      assert.equal(this, service);
      order.push(command);
      return Promise.reject(new Error('controlled native rejection'));
    },
  };
  const context = {
    selfUid,
    signal: controller.signal,
    resolvePeer: async () => {
      order.push('resolve');
      return { chatType: 2 as const, peerUid: '123' };
    },
    getMessageService: () => {
      order.push('acquire');
      return service;
    },
    sendPrepared: async () => {
      order.push('card');
      throw new Error('No card on failed upload');
    },
    defer: (value: () => void) => cleanup.push(value),
  };
  const owner = createForwardResourceOwner(context);
  return { owner, context, controller, cleanup, order };
}
const nodes = () => [{ userId: '456', nickname: 'fixture', time: 1, text: 'text' }];

test('owner preflights both operations before acquisition and keeps two independent lazy cleanup registrations', async () => {
  const f = fixture();
  try {
    assert.equal(f.cleanup.length, 2);
    assert.throws(() => f.owner.readResource(''));
    await assert.rejects(f.owner.sendMerged({ type: 'group', groupId: '123' }, [], {}));
    assert.deepEqual(f.order, []);
    const absentIdentity = fixture('');
    assert.throws(() => absentIdentity.owner.readResource('resource'));
    assert.deepEqual(absentIdentity.order, []);
    for (const cleanup of absentIdentity.cleanup) cleanup();
  } finally {
    for (const cleanup of f.cleanup) cleanup();
  }
});

test('read acquires lazily once and cannot dispatch after account retirement', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.owner.readResource('resource'));
    await assert.rejects(f.owner.readResource('resource'));
    assert.equal(f.order.filter((step) => step === 'acquire').length, 1);
    assert.deepEqual(
      f.order.filter((step) => step !== 'acquire'),
      [
        'trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg',
        'trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg',
      ],
    );
    f.controller.abort();
    assert.throws(() => f.owner.readResource('resource'));
    assert.equal(f.order.length, 3);
  } finally {
    for (const cleanup of f.cleanup) cleanup();
  }
});

test('retirement during UID wait prevents transport acquisition after resolution', async () => {
  const f = fixture();
  let resolve!: () => void;
  const pendingUid = new Promise<void>((done) => {
    resolve = done;
  });
  f.context.resolvePeer = async () => {
    f.order.push('resolve');
    await pendingUid;
    return { chatType: 2, peerUid: '123' };
  };
  // The owner receives ports once, so construct after selecting the controlled wait.
  for (const cleanup of f.cleanup) cleanup();
  const owner = createForwardResourceOwner(f.context);
  const pending = owner.sendMerged({ type: 'group', groupId: '123' }, nodes(), {});
  const checked = assert.rejects(pending, /aborted|closed/);
  f.controller.abort();
  resolve();
  await checked;
  assert.deepEqual(f.order, ['resolve']);
  for (const cleanup of f.cleanup) cleanup();
});

test('separate cleanup entries retire only their own transport and observe late native failures', async () => {
  const cleanup: (() => void)[] = [];
  const failures: ((error: Error) => void)[] = [];
  let acquisitions = 0;
  const owner = createForwardResourceOwner({
    selfUid: 'u_self',
    signal: new AbortController().signal,
    resolvePeer: async () => ({ chatType: 2, peerUid: '123' }),
    getMessageService: () => {
      acquisitions++;
      return {
        sendSsoCmdReqByContend: () => new Promise((_resolve, reject) => failures.push(reject)),
      };
    },
    sendPrepared: async () => assert.fail('Retired upload must not send a card'),
    defer: (step) => cleanup.push(step),
  });
  const upload = owner.sendMerged({ type: 'group', groupId: '123' }, nodes(), {});
  const checkedUpload = assert.rejects(upload, (error) => {
    assert.ok(error instanceof MergedForwardError);
    assert.equal(error.progress.uploadCompletion, 'unknown');
    assert.equal(error.progress.cardCompletion, 'not-dispatched');
    return true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  let readSettled = false;
  const read = owner.readResource('resource');
  const checkedRead = assert.rejects(read, (error) => {
    readSettled = true;
    assert.ok(error instanceof ForwardResourceError);
    assert.equal(error.stage, 'lifecycle');
    assert.equal(error.dispatched, true);
    return true;
  });
  try {
    assert.equal(acquisitions, 2);
    assert.equal(failures.length, 2);
    cleanup[0]();
    await checkedUpload;
    assert.equal(readSettled, false);
    cleanup[1]();
    await checkedRead;
    for (const reject of failures) reject(new Error('late native rejection'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(owner.readResource('resource'), (error) => {
      assert.ok(error instanceof ForwardResourceError);
      assert.equal(error.dispatched, false);
      return true;
    });
    assert.equal(acquisitions, 2);
  } finally {
    for (const step of cleanup) step();
  }
});

test('send keeps original resolve-before-acquire order and never sends card after upload rejection', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.owner.sendMerged({ type: 'group', groupId: '123' }, nodes(), {}));
    assert.deepEqual(f.order, [
      'resolve',
      'acquire',
      'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg',
    ]);
    f.controller.abort();
    await assert.rejects(f.owner.sendMerged({ type: 'group', groupId: '123' }, nodes(), {}));
    assert.equal(f.order.filter((s) => s === 'acquire').length, 1);
    assert.equal(f.order.includes('card'), false);
  } finally {
    for (const cleanup of f.cleanup) cleanup();
  }
});
