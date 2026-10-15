import assert from 'node:assert/strict';
import test from 'node:test';
import { captureContactOperation } from '../../../src/features/contacts/contact-operation-input.ts';
import { createContactOperations } from '../../../src/features/contacts/contact-operations.ts';
import { nativeUid as compatibilityUid } from '../../../src/features/messages/native-identities.ts';
import { NativeServiceLifetime } from '../../../src/runtime/native-service-lifetime.ts';
import { nativeUid } from '../../../src/validation/identifiers.ts';

const uid = 'opaque-uid';
const rawProfile = (uin = '0009007199254740993') => ({
  coreInfo: { uid, uin, nick: ' Name\n', remark: ' Remark\n' },
});
function fixture() {
  const lifetime = new NativeServiceLifetime();
  let result: unknown = new Map([[uid, rawProfile()]]);
  let acquisitions = 0;
  let resolutions = 0;
  const calls: unknown[][] = [];
  const service = {
    getCoreAndBaseInfo(this: unknown, ...args: unknown[]) {
      assert.equal(this, service);
      calls.push(args);
      return result;
    },
  };
  const operations = createContactOperations({
    signal: lifetime.signal,
    awaitAlive: lifetime.awaitAlive,
    getProfileService() {
      acquisitions++;
      return service;
    },
    getBuddyService() {
      assert.fail('A profile query must not acquire Buddy');
    },
    async resolveUid() {
      resolutions++;
      return uid;
    },
  });
  return {
    lifetime,
    operations,
    calls,
    acquired: () => acquisitions,
    resolved: () => resolutions,
    result(value: unknown) {
      result = value;
    },
  };
}

test('UID profile input reuses strict opaque UID validation without account coercion', async (t) => {
  assert.equal(nativeUid, compatibilityUid, 'Existing message imports retain the same validator');
  const f = fixture();
  t.after(() => f.lifetime.close());
  let reads = 0;
  const captured = captureContactOperation('getUserProfileByUid', {
    get uid() {
      reads++;
      return uid;
    },
    get userId() {
      return assert.fail('UID operations must not capture a QQ-number selector');
    },
  });
  assert.deepEqual(captured, { method: 'getUserProfileByUid', payload: { uid } });
  assert.equal(reads, 1);
  for (const value of [
    undefined,
    null,
    123,
    1n,
    '',
    ' ',
    ' u_person',
    'u_person\n',
    'u_masked*',
    new String(uid),
    { toString: () => assert.fail('UID input was coerced') },
  ]) {
    await assert.rejects(f.operations.invokeOperation('getUserProfileByUid', { uid: value }));
  }
  assert.equal(f.acquired(), 0);
  assert.equal(f.resolved(), 0);
  assert.deepEqual(f.calls, []);
});

test('UID profile makes one exact Profile call and preserves string identity, text and raw', async (t) => {
  const f = fixture();
  t.after(() => f.lifetime.close());
  const raw = rawProfile();
  f.result(
    new Map([
      ['u_unrelated', rawProfile('1')],
      [uid, raw],
    ]),
  );
  const result = await f.operations.invokeOperation('getUserProfileByUid', { uid });
  assert.deepEqual(result, {
    userId: '0009007199254740993',
    uid,
    nickname: ' Name\n',
    remark: ' Remark\n',
    raw,
  });
  assert.ok(result);
  assert.equal(result.raw, raw);
  assert.deepEqual(f.calls, [['nodeStore', [uid]]]);
  assert.equal(f.acquired(), 1);
  assert.equal(f.resolved(), 0);
});

test('UID profile rejects missing keys, mismatched UID and invalid UIN without a fallback', async (t) => {
  const f = fixture();
  t.after(() => f.lifetime.close());
  const valid = rawProfile().coreInfo;
  const rows: unknown[] = [
    undefined,
    null,
    [],
    {},
    { coreInfo: [] },
    ...[undefined, 'u_other', 1].map((value) => ({ coreInfo: { ...valid, uid: value } })),
    ...[
      undefined,
      '',
      '0',
      '000',
      '-1',
      '+123',
      '1.2',
      '1e3',
      ' 123',
      123,
      {
        toString: () => assert.fail('Native UIN was coerced'),
      },
    ].map((uin) => ({ coreInfo: { ...valid, uin } })),
  ];
  const responses = [
    undefined,
    {},
    new Map(),
    new Map([['u_other', rawProfile()]]),
    ...rows.map((row) => new Map([[uid, row]])),
  ];
  for (const response of responses) {
    f.result(response);
    await assert.rejects(f.operations.invokeOperation('getUserProfileByUid', { uid }));
  }
  assert.equal(f.calls.length, responses.length);
  assert.equal(f.resolved(), 0);
});

test('the existing QQ-number profile query retains literal equality and historical zero format', async (t) => {
  const f = fixture();
  t.after(() => f.lifetime.close());
  for (const userId of ['0', '000', '000123']) {
    f.result(new Map([[uid, rawProfile(userId)]]));
    const result = await f.operations.invokeOperation('getUserProfile', { userId });
    assert.ok(result);
    assert.equal(result.userId, userId);
  }
  const mismatched = rawProfile('123');
  Object.defineProperty(mismatched.coreInfo, 'nick', {
    get: () => assert.fail('Known account mismatch must reject before display reads'),
  });
  f.result(new Map([[uid, mismatched]]));
  await assert.rejects(
    f.operations.invokeOperation('getUserProfile', { userId: '000123' }),
    /identity does not match/,
  );
  assert.equal(f.resolved(), 4);
});

test('UID profile selects the actual Map entry without running a forged lookup', async (t) => {
  const f = fixture();
  t.after(() => f.lifetime.close());
  const raw = rawProfile();
  let lookups = 0;
  const missing = new Map([['u_other', raw]]);
  missing.get = () => {
    lookups++;
    return raw;
  };
  f.result(missing);
  await assert.rejects(
    f.operations.invokeOperation('getUserProfileByUid', { uid }),
    /missing the requested user/,
  );
  const present = new Map([[uid, raw]]);
  Object.defineProperty(present, 'get', {
    get() {
      lookups++;
      throw new Error('overridden lookup must not run');
    },
  });
  f.result(present);
  const result = await f.operations.invokeOperation('getUserProfileByUid', { uid });
  assert.ok(result);
  assert.equal(result.raw, raw);
  assert.equal(lookups, 0);
});

test('UID profile input retirement wins over a throwing accessor without service acquisition', async () => {
  const f = fixture();
  await assert.rejects(
    f.operations.invokeOperation('getUserProfileByUid', {
      get uid() {
        f.lifetime.close();
        throw new Error('input accessor failure');
      },
    }),
    (error) => error === f.lifetime.signal.reason,
  );
  assert.equal(f.acquired(), 0);
  assert.equal(f.resolved(), 0);
});

test('UID profile preserves active native errors and observes a retired provider without replay', async (t) => {
  const f = fixture();
  t.after(() => f.lifetime.close());
  const original = new Error('native profile query rejected');
  f.result(Promise.reject(original));
  await assert.rejects(
    f.operations.invokeOperation('getUserProfileByUid', { uid }),
    (error) => error === original,
  );
  let reject!: (error: Error) => void;
  f.result(
    new Promise((_, no) => {
      reject = no;
    }),
  );
  const pending = assert.rejects(
    f.operations.invokeOperation('getUserProfileByUid', { uid }),
    /Native services closed during operation/,
  );
  f.lifetime.close();
  await pending;
  reject(new Error('late native failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 2);
  assert.equal(f.resolved(), 0);
});

test('UID profile getter retirement stops identity projection before display fields', async () => {
  const f = fixture();
  const raw = rawProfile();
  let identityReads = 0;
  Object.defineProperty(raw.coreInfo, 'uin', {
    get() {
      identityReads++;
      f.lifetime.close();
      throw new Error('opaque native getter failure');
    },
  });
  Object.defineProperty(raw.coreInfo, 'nick', {
    get: () => assert.fail('Retired query read another profile field'),
  });
  f.result(new Map([[uid, raw]]));
  await assert.rejects(
    f.operations.invokeOperation('getUserProfileByUid', { uid }),
    (error) => error === f.lifetime.signal.reason,
  );
  assert.equal(identityReads, 1);
  assert.equal(f.calls.length, 1);
});
