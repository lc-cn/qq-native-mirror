import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGroupSearch,
  type GroupSearchPort,
} from '../../../src/features/groups/group-search.ts';
import { createNativeEventChannel } from '../../../src/runtime/native-event-channel.ts';
import { NativeServiceLifetime } from '../../../src/runtime/native-service-lifetime.ts';

function fixture() {
  const life = new NativeServiceLifetime();
  const channel = createNativeEventChannel(life.signal);
  const order: string[] = [];
  let supported = true;
  let acquire: () => void = () => {};
  let register: () => void = () => {};
  let method: () => void = () => {};
  const service: GroupSearchPort = {
    get searchGroup() {
      method();
      return function (
        this: GroupSearchPort,
        parameters: Parameters<NonNullable<GroupSearchPort['searchGroup']>>[0],
      ) {
        assert.equal(this, service);
        order.push(`dispatch:${parameters.keyWords}`);
        channel.dispatch('Search/onSearchGroupResult', [response(parameters.keyWords)]);
        return { result: 0 };
      };
    },
  };
  const api = createGroupSearch({
    signal: life.signal,
    awaitAlive: life.awaitAlive,
    eventCall: channel.call,
    supportsSearch: () => supported,
    getSearchService() {
      order.push('acquire');
      acquire();
      return service;
    },
    registerSearchListener(value) {
      assert.equal(value, service);
      order.push('register');
      register();
    },
  });
  return {
    api,
    life,
    channel,
    order,
    supported(value: boolean) {
      supported = value;
    },
    acquire(value: () => void) {
      acquire = value;
    },
    method(value: () => void) {
      method = value;
    },
    register(value: () => void) {
      register = value;
    },
    close() {
      api.close();
      channel.close();
      life.close();
    },
  };
}
function response(keyWord: string) {
  return { keyWord, errorode: 0, isEnd: true, groupInfos: [] };
}
test('search registration: invalid and unsupported inputs acquire nothing', async () => {
  const f = fixture();
  try {
    await assert.rejects(async () => f.api.searchGroup('0'));
    f.supported(false);
    await assert.rejects(async () => f.api.searchGroup('123'), {
      code: 'unsupported-native-contract',
    });
    assert.deepEqual(f.order, []);
  } finally {
    f.close();
  }
});
test('search registration: one cached service and registration precedes every dispatch', async () => {
  const f = fixture();
  try {
    await Promise.all([f.api.searchGroup('123'), f.api.searchGroup('456')]);
    await f.api.searchGroup('789');
    assert.deepEqual(f.order, [
      'acquire',
      'register',
      'dispatch:123',
      'dispatch:456',
      'dispatch:789',
    ]);
  } finally {
    f.close();
  }
});
for (const phase of ['acquire', 'register', 'method'] as const) {
  for (const retirement of ['local', 'account'] as const) {
    for (const throws of [false, true]) {
      test(`search registration: ${phase} ${retirement} retirement${throws ? ' plus throw' : ''} prevents dispatch`, async () => {
        const f = fixture();
        f[phase](() => {
          if (retirement === 'local') f.api.close();
          else f.life.close();
          if (throws) throw new Error('acquisition failure after retirement');
        });
        try {
          await assert.rejects(
            f.api.searchGroup('123'),
            retirement === 'account'
              ? (error: unknown) => error === f.life.signal.reason
              : /Group search is closed/,
          );
          assert.equal(
            f.order.some((value) => value.startsWith('dispatch:')),
            false,
          );
          if (phase === 'acquire') assert.deepEqual(f.order, ['acquire']);
        } finally {
          f.close();
        }
      });
    }
  }
  test(`search registration: active ${phase} exception preserves identity and quarantines queued requests`, async () => {
    const f = fixture();
    const error = new Error('original registration error');
    f[phase](() => {
      throw error;
    });
    try {
      const first = f.api.searchGroup('123');
      const second = f.api.searchGroup('456');
      await assert.rejects(first, (value: unknown) => value === error);
      await assert.rejects(second, /invalidated/);
      await assert.rejects(f.api.searchGroup('789'), /invalidated/);
      assert.deepEqual(f.order, phase === 'acquire' ? ['acquire'] : ['acquire', 'register']);
    } finally {
      f.close();
    }
  });
}
test('search registration: synchronous registration notification cannot satisfy a later dispatched search', async () => {
  const f = fixture();
  f.register(() => channelNotification());
  function channelNotification() {
    f.channel.dispatch('Search/onSearchGroupResult', [{ ...response('123'), errorode: 7 }]);
  }
  try {
    assert.equal(await f.api.searchGroup('123'), undefined);
    assert.deepEqual(f.order, ['acquire', 'register', 'dispatch:123']);
  } finally {
    f.close();
  }
});
