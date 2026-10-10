import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeKernelError,
  deserializeKernelError,
  KernelRequestError,
  MergedForwardError,
} from '../src/errors.ts';
test('kernel error serialization preserves codes without serializing arbitrary payloads', () => {
  const original = Object.assign(new Error('native operation failed'), {
    code: 23,
    secret: 'fixture secret',
    cause: { token: 'fixture token' },
  });
  const serialized = serializeKernelError(original);
  assert.deepEqual(serialized, { message: 'native operation failed', name: 'Error', code: 23 });
  const restored = deserializeKernelError('setGroupName', serialized);
  assert.ok(restored instanceof KernelRequestError);
  assert.equal(restored.operation, 'setGroupName');
  assert.equal(restored.code, 23);
  assert.equal(restored.message, original.message);
  assert.equal(restored.originalName, 'Error');
  assert.ok(!JSON.stringify(serialized).includes('fixture'));
});
test('legacy string failures and malformed error codes retain deterministic worker errors', () => {
  assert.equal(deserializeKernelError('init', 'old error').message, 'old error');
  assert.equal(
    deserializeKernelError('init', { message: 'bad', code: { secret: 'never copy' } }).code,
    undefined,
  );
  assert.equal(deserializeKernelError('init', null).message, 'Kernel request failed');
  assert.deepEqual(
    serializeKernelError(Object.assign(new Error('missing file'), { code: 'ENOENT' })),
    { message: 'missing file', name: 'Error', code: 'ENOENT' },
  );
});

test('merged-forward IPC retains only checked partial progress and primitive native code', () => {
  const original = Object.assign(
    new MergedForwardError(
      'card',
      'Merged-forward card sending failed',
      {
        uploadCompletion: 'resource-received',
        cardCompletion: 'unknown',
        resourceId: 'resource-fixture',
      },
      23,
    ),
    { secret: 'never-copy', cause: { token: 'never-copy' } },
  );
  const serialized = serializeKernelError(original);
  assert.deepEqual(serialized, {
    message: original.message,
    name: 'MergedForwardError',
    code: 23,
    mergedForward: {
      phase: 'card',
      uploadCompletion: 'resource-received',
      cardCompletion: 'unknown',
      resourceId: 'resource-fixture',
    },
  });
  const restored = deserializeKernelError(
    'sendMergedForward',
    JSON.parse(JSON.stringify(serialized)),
  );
  assert.deepEqual(restored.mergedForward, serialized.mergedForward);
  assert.equal(restored.code, 23);
  assert.ok(!JSON.stringify(serialized).includes('never-copy'));
  const mutations: ((value: Record<string, unknown>) => unknown)[] = [
    (v) => (v.phase = 'invalid'),
    (v) => (v.uploadCompletion = 'done'),
    (v) => (v.cardCompletion = 'done'),
    (v) => delete v.resourceId,
    (v) => (v.resourceId = 'x'.repeat(4097)),
    (v) => (v.uploadCompletion = 'unknown'),
  ];
  for (const mutate of mutations) {
    const value: ReturnType<typeof serializeKernelError> = structuredClone(serialized);
    mutate(value.mergedForward as unknown as Record<string, unknown>);
    assert.equal(deserializeKernelError('sendMergedForward', value).mergedForward, undefined);
  }
  const raw = Object.assign(Error('ordinary'), { mergedForward: serialized.mergedForward });
  assert.equal(serializeKernelError(raw).mergedForward, undefined);
});
