import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeKernelError, normalizeKernelError, MergedForwardError } from '../src/errors.ts';

test('opaque errors never coerce and revoked proxies are safe', () => {
  let calls = 0;
  const opaque = {
    toString() {
      calls++;
      throw Error('private');
    },
    [Symbol.toPrimitive]() {
      calls++;
      throw Error('private');
    },
  };
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [opaque, revoked.proxy, () => {}, Object.create(null)])
    assert.deepEqual(serializeKernelError(value), { message: 'Kernel request failed' });
  assert.equal(calls, 0);
  for (const value of ['failure', 9, false, 1n, undefined, null, Symbol('failure')])
    assert.deepEqual(serializeKernelError(value), { message: String(value) });
});

test('Error data fields are inherited without executing getters', () => {
  const error = Error('ordinary');
  Object.setPrototypeOf(
    error,
    Object.assign(Object.create(Error.prototype), { name: 'InheritedError', code: 7 }),
  );
  assert.deepEqual(serializeKernelError(error), {
    message: 'ordinary',
    name: 'InheritedError',
    code: 7,
  });
  for (const field of ['message', 'name', 'code']) {
    let calls = 0;
    const error = Error('ordinary');
    Object.defineProperty(error, field, {
      get() {
        calls++;
        throw Error('private');
      },
    });
    const result = serializeKernelError(error);
    assert.equal(calls, 0);
    assert.equal(result.message, field === 'message' ? 'Kernel request failed' : 'ordinary');
    assert.equal(result.code, undefined);
    assert.equal(result.name, field === 'name' ? undefined : 'Error');
  }
});

test('proxy traps and cyclic prototype lookup cannot escape serialization', () => {
  const error = new Proxy(Error('private'), {
    getOwnPropertyDescriptor() {
      throw Error('trap');
    },
  });
  assert.deepEqual(serializeKernelError(error), { message: 'Kernel request failed' });
  const cycle: object = new Proxy(
    {},
    {
      getPrototypeOf(): object {
        return cycle;
      },
    },
  );
  assert.deepEqual(serializeKernelError(cycle), { message: 'Kernel request failed' });
});

test('merged progress accessors, revoked and circular fields are opaque, valid progress survives', () => {
  const original = () =>
    new MergedForwardError(
      'upload',
      'failed',
      { uploadCompletion: 'unknown', cardCompletion: 'not-dispatched' },
      23,
    );
  assert.deepEqual(serializeKernelError(original()).mergedForward, {
    phase: 'upload',
    uploadCompletion: 'unknown',
    cardCompletion: 'not-dispatched',
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const circular: any = {};
  circular.phase = circular;
  circular.uploadCompletion = circular;
  for (const progress of [
    revoked.proxy,
    circular,
    {
      get uploadCompletion() {
        throw Error('private');
      },
      cardCompletion: 'unknown',
    },
  ]) {
    const error = original();
    Object.defineProperty(error, 'progress', { value: progress });
    assert.equal(serializeKernelError(error).mergedForward, undefined);
  }
  const error = original();
  Object.defineProperty(error, 'phase', {
    get() {
      throw Error('private');
    },
  });
  assert.equal(serializeKernelError(error).mergedForward, undefined);
});

test('normalization preserves safe Error identity and never coerces opaque failure', () => {
  const original = Object.assign(Error('ordinary'), { code: 23 });
  assert.equal(normalizeKernelError(original), original);
  const opaque = {
    toString() {
      throw Error('must not coerce');
    },
  };
  assert.equal(normalizeKernelError(opaque).message, 'Kernel request failed');
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(normalizeKernelError(revoked.proxy).message, 'Kernel request failed');
  const error = Object.assign(Error('private'), { code: 'E_NATIVE' });
  Object.defineProperty(error, 'message', {
    get() {
      throw Error('must not invoke');
    },
  });
  const normalized = normalizeKernelError(error);
  assert.notEqual(normalized, error);
  assert.equal(normalized.message, 'Kernel request failed');
  assert.equal((normalized as Error & { code: unknown }).code, 'E_NATIVE');
  assert.equal(normalizeKernelError('primitive failure').message, 'primitive failure');
});
