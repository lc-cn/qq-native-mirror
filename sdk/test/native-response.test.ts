import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { discardNativeResponse, readNativeResponse } from '../src/native/native-response.ts';

const policy = {
  maxBytes: 3,
  errors: {
    http: (status: number) => `HTTP ${status}`,
    empty: (status: number) => `Empty ${status}`,
    tooLarge: 'Too large',
  },
};

test('caller cancellation interrupts a stalled body and awaits cancellation before release', async () => {
  const controller = new AbortController();
  const reason = new Error('body cancelled');
  let release!: () => void;
  let cancellationStarted!: () => void;
  const started = new Promise<void>((resolve) => (cancellationStarted = resolve));
  const stream = observedStream({
    cancel(value) {
      assert.equal(value, reason);
      cancellationStarted();
      return new Promise<void>((resolve) => (release = resolve));
    },
  });
  const reading = readNativeResponse(new Response(stream.body), {
    ...policy,
    signal: controller.signal,
  });
  const rejected = assert.rejects(reading, (error) => error === reason);
  controller.abort(reason);
  await started;
  assert.deepEqual(stream.counts(), { cancellations: 1, releases: 0 });
  release();
  await rejected;
  assert.deepEqual(stream.counts(), { cancellations: 1, releases: 1 });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation retains a distinct body cleanup failure without a second cancellation', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  const cleanup = new Error('cancel cleanup failed');
  const stream = observedStream({
    cancel() {
      throw cleanup;
    },
  });
  const reading = readNativeResponse(new Response(stream.body), {
    ...policy,
    signal: controller.signal,
  });
  const rejected = assert.rejects(reading, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [reason, cleanup]);
    return true;
  });
  controller.abort(reason);
  await rejected;
  assert.deepEqual(stream.counts(), { cancellations: 1, releases: 1 });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('successful body removes cancellation listener and ignores a later abort', async () => {
  const controller = new AbortController();
  const stream = observedStream({
    start(value) {
      value.close();
    },
  });
  assert.deepEqual(
    await readNativeResponse(new Response(stream.body), { ...policy, signal: controller.signal }),
    Buffer.alloc(0),
  );
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  assert.deepEqual(stream.counts(), { cancellations: 0, releases: 1 });
});

function observedStream(source: UnderlyingDefaultSource<Uint8Array>, afterRelease?: () => void) {
  const body = new ReadableStream<Uint8Array>(source);
  const getReader = body.getReader.bind(body);
  let cancellations = 0;
  let releases = 0;
  Object.defineProperty(body, 'getReader', {
    value() {
      const reader = getReader();
      const cancel = reader.cancel.bind(reader);
      const release = reader.releaseLock.bind(reader);
      Object.defineProperty(reader, 'cancel', {
        value(reason: unknown) {
          cancellations++;
          return cancel(reason);
        },
      });
      Object.defineProperty(reader, 'releaseLock', {
        value() {
          releases++;
          release();
          afterRelease?.();
        },
      });
      return reader;
    },
  });
  return { body, counts: () => ({ cancellations, releases }) };
}

test('successful exact-limit read copies chunks and releases without cancellation', async () => {
  const shared = new Uint8Array([1, 2]);
  let pulls = 0;
  const stream = observedStream({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(shared);
      else {
        shared.fill(9);
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      }
    },
  });
  const result = await readNativeResponse(new Response(stream.body), policy);
  assert.deepEqual(result, Buffer.from([1, 2, 3]));
  assert.deepEqual(stream.counts(), { cancellations: 0, releases: 1 });
  assert.equal(stream.body.locked, false);
});

test('HTTP rejection cancels unread body and keeps caller error text', async () => {
  let cancels = 0;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancels++;
      },
    }),
    { status: 503 },
  );
  await assert.rejects(readNativeResponse(response, policy), { message: 'HTTP 503' });
  assert.equal(cancels, 1);
  await assert.rejects(readNativeResponse(new Response(null), policy), { message: 'Empty 200' });
});

test('oversize read cancels acquired reader once and releases its lock', async () => {
  let reason: unknown;
  const stream = observedStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4));
    },
    cancel(value) {
      reason = value;
    },
  });
  await assert.rejects(readNativeResponse(new Response(stream.body), policy), {
    message: 'Too large',
  });
  assert.ok(reason instanceof Error);
  assert.equal(reason.message, 'Too large');
  assert.deepEqual(stream.counts(), { cancellations: 1, releases: 1 });
  assert.equal(stream.body.locked, false);
});

test('errored stream retains its original error when cancellation rejects the same value', async () => {
  const primary = new Error('Stream failed');
  const stream = observedStream({
    start(controller) {
      controller.error(primary);
    },
  });
  await assert.rejects(
    readNativeResponse(new Response(stream.body), policy),
    (error) => error === primary,
  );
  assert.deepEqual(stream.counts(), { cancellations: 1, releases: 1 });
  assert.equal(stream.body.locked, false);
});

test('discard keeps opaque cleanup alongside primary and preserves undefined failures', async () => {
  const primary = new Error('Redirect rejected');
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const response = new Response(
    new ReadableStream({
      cancel() {
        throw revoked.proxy;
      },
    }),
  );
  await assert.rejects(discardNativeResponse(response, { error: primary }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], primary);
    assert.equal(error.errors[1], revoked.proxy);
    return true;
  });
  await discardNativeResponse(new Response(null), { error: undefined }).then(
    () => assert.fail('Undefined primary must reject'),
    (error: unknown) => assert.equal(error, undefined),
  );
  const cleanup = new Error('Discard failed');
  await assert.rejects(
    discardNativeResponse(
      new Response(
        new ReadableStream({
          cancel() {
            throw cleanup;
          },
        }),
      ),
    ),
    (error) => error === cleanup,
  );
});

test('reader acquisition failure cancels the unacquired body and preserves primary', async () => {
  const primary = new Error('Reader acquisition failed');
  const cleanup = new Error('Body cancellation failed');
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancels++;
      throw cleanup;
    },
  });
  Object.defineProperty(body, 'getReader', {
    value() {
      throw primary;
    },
  });
  await assert.rejects(readNativeResponse(new Response(body), policy), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, cleanup]);
    return true;
  });
  assert.equal(cancels, 1);
});

test('read, opaque cancellation and release failures remain ordered with one release', async () => {
  const cleanup = Proxy.revocable({}, {});
  cleanup.revoke();
  const released = new Error('Release failed');
  const stream = observedStream(
    {
      start(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        throw cleanup.proxy;
      },
    },
    () => {
      throw released;
    },
  );
  await assert.rejects(readNativeResponse(new Response(stream.body), policy), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors[0] instanceof AggregateError);
    assert.equal(error.errors[0].errors[0].message, 'Too large');
    assert.equal(error.errors[0].errors[1], cleanup.proxy);
    assert.equal(error.errors[1], released);
    return true;
  });
  assert.deepEqual(stream.counts(), { cancellations: 1, releases: 1 });
  assert.equal(stream.body.locked, false);
});

test('successful EOF with release failure rejects that original failure without cancellation', async () => {
  const failure = new Error('Release failed');
  const stream = observedStream(
    {
      start(controller) {
        controller.close();
      },
    },
    () => {
      throw failure;
    },
  );
  await assert.rejects(
    readNativeResponse(new Response(stream.body), policy),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(stream.counts(), { cancellations: 0, releases: 1 });
});
