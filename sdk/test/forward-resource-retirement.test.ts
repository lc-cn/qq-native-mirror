import assert from 'node:assert/strict';
import test from 'node:test';
import { MergedForwardError } from '../src/errors.ts';
import {
  createForwardResourceOwner,
  type ForwardResourceOwnerContext,
} from '../src/features/forward/forward-resource-owner.ts';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const peer = { type: 'group', groupId: '123' };
const nodes = [{ userId: '456', nickname: 'fixture', time: 1, text: 'text' }];
function fixture() {
  const controller = new AbortController(),
    cleanup: (() => void)[] = [],
    order: string[] = [];
  const failure = new Error('controlled native failure');
  const service = {
    sendSsoCmdReqByContend() {
      assert.equal(this, service);
      order.push('native');
      return Promise.reject(failure);
    },
  };
  const context: ForwardResourceOwnerContext = {
    selfUid: 'u_self',
    signal: controller.signal,
    resolvePeer: async () => {
      order.push('resolve');
      return { chatType: 2, peerUid: '123' };
    },
    getMessageService() {
      order.push('acquire');
      return service;
    },
    sendPrepared: async () => {
      order.push('card');
      throw Error('unexpected card');
    },
    defer: (close) => cleanup.push(close),
  };
  const owner = createForwardResourceOwner(context);
  return {
    controller,
    cleanup,
    order,
    service,
    context,
    owner,
    close() {
      for (const close of cleanup) close();
      controller.abort();
    },
  };
}
async function rejectedWithin(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      assert.rejects(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Owner did not retire within 100ms')), 100);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
test('forward upload preabort prevents even peer resolution', async () => {
  const f = fixture();
  f.controller.abort();
  try {
    await assert.rejects(f.owner.sendMerged(peer, nodes, {}));
    assert.deepEqual(f.order, []);
  } finally {
    f.close();
  }
});
test('forward upload cleanup before first use retires only upload lane', async () => {
  const f = fixture();
  f.cleanup[0]!();
  try {
    await assert.rejects(f.owner.sendMerged(peer, nodes, {}));
    assert.deepEqual(f.order, []);
    await assert.rejects(f.owner.readResource('resource'));
    assert.deepEqual(f.order, ['acquire', 'native']);
  } finally {
    f.close();
  }
});
test('forward read cleanup before first use retires only read lane', async () => {
  const f = fixture();
  f.cleanup[1]!();
  try {
    await assert.rejects(async () => f.owner.readResource('resource'));
    assert.deepEqual(f.order, []);
    await assert.rejects(f.owner.sendMerged(peer, nodes, {}));
    assert.deepEqual(f.order, ['resolve', 'acquire', 'native']);
  } finally {
    f.close();
  }
});
for (const retirement of ['local', 'account'] as const) {
  test(`forward pending peer resolution ${retirement} retirement settles and observes late failure`, async () => {
    const f = fixture(),
      pending = deferred<{ chatType: 2; peerUid: string }>();
    f.context.resolvePeer = () => {
      f.order.push('resolve');
      return pending.promise;
    };
    const result = f.owner.sendMerged(peer, nodes, {});
    if (retirement === 'local') f.cleanup[0]!();
    else f.controller.abort();
    try {
      await rejectedWithin(result);
      assert.deepEqual(f.order, ['resolve']);
    } finally {
      pending.reject(new Error('late resolver failure'));
      await assert.rejects(result);
      f.close();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}
for (const throws of [false, true]) {
  test(`forward service acquisition abort${throws ? ' plus throw' : ''} prevents native dispatch`, async () => {
    const f = fixture();
    f.context.getMessageService = () => {
      f.order.push('acquire');
      f.controller.abort();
      if (throws) throw Error('after abort');
      return f.service;
    };
    try {
      await assert.rejects(f.owner.sendMerged(peer, nodes, {}));
      assert.deepEqual(f.order, ['resolve', 'acquire']);
    } finally {
      f.close();
    }
  });
}
test('forward active read service exception preserves original identity', async () => {
  const f = fixture(),
    original = new Error('original');
  f.context.getMessageService = () => {
    throw original;
  };
  try {
    await assert.rejects(
      async () => f.owner.readResource('resource'),
      (error: unknown) => error === original,
    );
  } finally {
    f.close();
  }
});
test('forward pending card retirement preserves uploaded resource and one submission', async () => {
  const f = fixture(),
    card = deferred<{ messageId: string; sequence: string; time: number }>(),
    entered = deferred<void>();
  f.context.getMessageService = () => ({
    sendSsoCmdReqByContend() {
      f.order.push('upload');
      return { rspbuffer: Buffer.from('120d1a0b7265732d66697874757265', 'hex') };
    },
  });
  f.context.sendPrepared = async (_peer, _elements, onDispatch) => {
    f.order.push('card');
    onDispatch();
    entered.resolve();
    return card.promise;
  };
  const result = f.owner.sendMerged(peer, nodes, {});
  await entered.promise;
  f.cleanup[0]!();
  try {
    await rejectedWithin(result);
    await assert.rejects(
      result,
      (error: unknown) =>
        error instanceof MergedForwardError &&
        error.progress.resourceId === 'res-fixture' &&
        error.progress.cardCompletion === 'unknown',
    );
    assert.deepEqual(f.order, ['resolve', 'upload', 'card']);
  } finally {
    card.reject(Error('late card failure'));
    await assert.rejects(result);
    f.close();
  }
});
test('forward upload constructor method getter abort prevents native invocation', async () => {
  const f = fixture();
  f.context.getMessageService = () => ({
    get sendSsoCmdReqByContend() {
      f.controller.abort();
      return () => {
        f.order.push('native');
        return Promise.reject(Error('must not dispatch'));
      };
    },
  });
  try {
    await assert.rejects(f.owner.sendMerged(peer, nodes, {}));
    assert.deepEqual(f.order, ['resolve']);
  } finally {
    f.close();
  }
});
for (const field of ['resolvePeer', 'sendPrepared'] as const) {
  test(`forward ${field} getter retirement prevents invoking returned method`, async () => {
    const f = fixture();
    f.context.getMessageService = () => ({
      sendSsoCmdReqByContend() {
        f.order.push('upload');
        return { rspbuffer: Buffer.from('120d1a0b7265732d66697874757265', 'hex') };
      },
    });
    Object.defineProperty(f.context, field, {
      get() {
        f.controller.abort();
        return () => {
          f.order.push('forbidden');
          throw Error('must not invoke');
        };
      },
    });
    try {
      await assert.rejects(f.owner.sendMerged(peer, nodes, {}));
      assert.equal(f.order.includes('forbidden'), false);
      assert.deepEqual(f.order, field === 'resolvePeer' ? [] : ['resolve', 'upload']);
    } finally {
      f.close();
    }
  });
}
test('forward captured context methods preserve receiver and invoke each once', async () => {
  const f = fixture();
  f.context.resolvePeer = async function () {
    assert.equal(this, f.context);
    f.order.push('resolve');
    return { chatType: 2, peerUid: '123' };
  };
  f.context.getMessageService = function () {
    assert.equal(this, f.context);
    f.order.push('acquire');
    return {
      sendSsoCmdReqByContend() {
        f.order.push('upload');
        return { rspbuffer: Buffer.from('120d1a0b7265732d66697874757265', 'hex') };
      },
    };
  };
  f.context.sendPrepared = async function (_peer, _elements, onDispatch) {
    assert.equal(this, f.context);
    f.order.push('card');
    onDispatch();
    return { messageId: '42', sequence: '9', time: 100 };
  };
  try {
    assert.equal((await f.owner.sendMerged(peer, nodes, {})).resourceId, 'res-fixture');
    assert.deepEqual(f.order, ['resolve', 'acquire', 'upload', 'card']);
  } finally {
    f.close();
  }
});
for (const nativeFailure of [false, true]) {
  test(`forward synchronous card abort preserves ${nativeFailure ? 'settled native failure code' : 'no successful publication'}`, async () => {
    const f = fixture();
    f.context.getMessageService = () => ({
      sendSsoCmdReqByContend() {
        return { rspbuffer: Buffer.from('120d1a0b7265732d66697874757265', 'hex') };
      },
    });
    f.context.sendPrepared = (_peer, _elements, onDispatch) => {
      f.order.push('card');
      onDispatch();
      f.controller.abort(new Error('closed'));
      return nativeFailure
        ? Promise.reject(Object.assign(new Error('failed'), { code: 7 }))
        : Promise.resolve({ messageId: '42', sequence: '9', time: 100 });
    };
    try {
      await assert.rejects(f.owner.sendMerged(peer, nodes, {}), (error: unknown) => {
        assert.ok(error instanceof MergedForwardError);
        assert.equal(error.progress.resourceId, 'res-fixture');
        assert.equal(error.progress.cardCompletion, 'unknown');
        if (nativeFailure) assert.equal(error.code, 7);
        return true;
      });
      assert.deepEqual(f.order, ['resolve', 'card']);
    } finally {
      f.close();
    }
  });
}
