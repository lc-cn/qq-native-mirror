import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroupFiles } from '../../../src/features/groups/files/group-files.ts';
import {
  createGroupFilePages,
  GroupFilePageHistory,
} from '../../../src/features/groups/files/group-file-pages.ts';

function callback(reqId: number, overrides: Record<string, unknown> = {}) {
  return {
    reqId,
    retCode: 0,
    retMsg: '',
    clientWording: '',
    isEnd: true,
    item: [],
    allFileCount: 0,
    nextIndex: 0,
    ...overrides,
  };
}
function fixture(history = new GroupFilePageHistory()) {
  const controller = new AbortController();
  const calls: { groupId: string; params: unknown; receiver: unknown }[] = [];
  let token = 0;
  let dispatch: ((groupId: string) => unknown) | undefined;
  const service = {
    getGroupFileList(this: unknown, groupId: string, params: unknown): unknown {
      calls.push({ groupId, params, receiver: this });
      return dispatch ? dispatch(groupId) : token++;
    },
  };
  let acquisitions = 0;
  let supported = true;
  const owner = createGroupFilePages({
    signal: controller.signal,
    history,
    supportsFilePage: () => supported,
    getFilePageService: () => {
      acquisitions++;
      return service;
    },
  });
  return {
    owner,
    calls,
    controller,
    service,
    setDispatch(value: typeof dispatch) {
      dispatch = value;
    },
    setSupported(value: boolean) {
      supported = value;
    },
    acquisitions: () => acquisitions,
  };
}

test('input, capability and pre-abort reject before native acquisition', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.owner.getGroupFilePage('bad'), /group/i);
    f.setSupported(false);
    await assert.rejects(f.owner.getGroupFilePage('123'), /not verified/);
    f.setSupported(true);
    const signal = AbortSignal.abort(new Error('request stopped'));
    await assert.rejects(f.owner.getGroupFilePage('123', {}, signal), /request stopped/);
    assert.equal(f.acquisitions(), 0);
  } finally {
    f.owner.close();
  }
});

test('zero token, early detached callback, receiver and first-page policy', async () => {
  const f = fixture();
  const raw = callback(0, {
    isEnd: false,
    nextIndex: 4,
    item: [{ peerId: '123', type: -3, folderInfo: null, fileInfo: null }],
  });
  f.setDispatch(() => {
    f.owner.receiveFileInfo(raw);
    raw.nextIndex = 99;
    raw.item = [];
    return 0;
  });
  try {
    const page = await f.owner.getGroupFilePage('123', { folderId: 'folder', fileCount: 9 });
    assert.equal(page.nextIndex, 4);
    assert.equal(page.items.length, 1);
    assert.equal(page.isEnd, false);
    assert.equal(page.folderId, 'folder');
    assert.equal(page.fileCount, 9);
    assert.equal(f.calls[0]?.receiver, f.service);
  } finally {
    f.owner.close();
  }
});

test('native synchronous throw wins over successful early callback and quarantines unknown token', async () => {
  const history = new GroupFilePageHistory();
  const f = fixture(history);
  const failure = { marker: 1 };
  f.setDispatch(() => {
    f.owner.receiveFileInfo(callback(0));
    throw failure;
  });
  try {
    await assert.rejects(f.owner.getGroupFilePage('123'), (error: unknown) => error === failure);
    const next = fixture(history);
    try {
      await assert.rejects(next.owner.getGroupFilePage('123'), /quarantined/);
      assert.equal(next.calls.length, 0);
    } finally {
      next.owner.close();
    }
  } finally {
    f.owner.close();
  }
});

test('wrong token malformed body ignored, matching malformed or mismatched group rejected', async () => {
  const f = fixture();
  try {
    const pending = f.owner.getGroupFilePage('123');
    f.owner.receiveFileInfo(callback(8, { item: 'bad' }));
    f.owner.receiveFileInfo(callback(0));
    assert.deepEqual((await pending).items, []);
    const mismatch = f.owner.getGroupFilePage('123');
    f.owner.receiveFileInfo(
      callback(1, { item: [{ peerId: '124', type: 0, folderInfo: null, fileInfo: null }] }),
    );
    await assert.rejects(mismatch, /conversation/);
    const error = f.owner.getGroupFilePage('123');
    f.owner.receiveFileInfo(callback(2, { retCode: -9, retMsg: 'secret' }));
    await assert.rejects(
      error,
      (value: unknown) =>
        value instanceof Error &&
        !value.message.includes('secret') &&
        Reflect.get(value, 'code') === -9,
    );
  } finally {
    f.owner.close();
  }
});

test('duplicate token persists across owner/account recreation; other owner cannot overlap lease', async () => {
  const history = new GroupFilePageHistory();
  const a = fixture(history);
  const b = fixture(history);
  try {
    const pending = a.owner.getGroupFilePage('123');
    await assert.rejects(b.owner.getGroupFilePage('123'), /active/);
    assert.equal(b.calls.length, 0);
    a.owner.receiveFileInfo(callback(0));
    await pending;
    a.owner.close();
    await assert.rejects(b.owner.getGroupFilePage('123'), /Duplicate/);
    await assert.rejects(b.owner.getGroupFilePage('123'), /quarantined/);
    assert.equal(b.calls.length, 1);
  } finally {
    a.owner.close();
    b.owner.close();
  }
});

test('queued request cancellation removes it without acquisition; known token close remains recorded', async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    const first = f.owner.getGroupFilePage('123');
    first.catch(() => {});
    const queued = f.owner.getGroupFilePage('123', {}, controller.signal);
    controller.abort();
    await assert.rejects(queued, /cancelled/);
    assert.equal(f.calls.length, 1);
    f.owner.receiveFileInfo(callback(0));
    await first;
    const active = f.owner.getGroupFilePage('123');
    f.owner.close();
    await assert.rejects(active, /closed/);
    f.owner.receiveFileInfo(callback(1));
    assert.equal(f.calls.length, 2);
  } finally {
    f.owner.close();
  }
});

test('service and method getter reentrant close prevent dispatch, getters read once', async () => {
  for (const stage of ['service', 'method'] as const) {
    const controller = new AbortController();
    let reads = 0;
    let calls = 0;
    const service = {
      get getGroupFileList() {
        reads++;
        if (stage === 'method') owner.close();
        return () => {
          calls++;
          return 0;
        };
      },
    };
    const owner = createGroupFilePages({
      signal: controller.signal,
      history: new GroupFilePageHistory(),
      supportsFilePage: () => true,
      getFilePageService: () => {
        if (stage === 'service') owner.close();
        return service;
      },
    });
    await assert.rejects(owner.getGroupFilePage('123'), /closed/);
    assert.equal(calls, 0);
    assert.equal(reads, stage === 'method' ? 1 : 0);
    owner.close();
  }
});

test('invalid asynchronous token is observed and quarantined; early callback overflow fails closed', async () => {
  const history = new GroupFilePageHistory();
  const f = fixture(history);
  let reject!: (value: unknown) => void;
  f.setDispatch(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  try {
    await assert.rejects(f.owner.getGroupFilePage('123'), /request token/);
    reject(new Error('late rejection'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(f.owner.getGroupFilePage('123'), /quarantined/);
  } finally {
    f.owner.close();
  }
  const g = fixture();
  g.setDispatch(() => {
    for (let i = 0; i < 17; i++) g.owner.receiveFileInfo(callback(i));
    return 0;
  });
  try {
    await assert.rejects(g.owner.getGroupFilePage('123'), /budget/);
    await assert.rejects(g.owner.getGroupFilePage('123'), /quarantined/);
  } finally {
    g.owner.close();
  }
});

test('listing follows native cursor with new tokens and never returns budget/stalled partial data', async () => {
  const f = fixture();
  let index = 0;
  f.setDispatch(() => {
    const token = index++;
    f.owner.receiveFileInfo(
      callback(token, { isEnd: token === 1, nextIndex: token === 0 ? 3 : 4 }),
    );
    return token;
  });
  try {
    assert.deepEqual(await f.owner.listGroupFiles('123'), []);
    assert.deepEqual(
      f.calls.map((call) => Reflect.get(Object(call.params), 'startIndex')),
      [0, 3],
    );
  } finally {
    f.owner.close();
  }
  for (const nextIndex of [0, 1]) {
    const g = fixture();
    g.setDispatch(() => {
      g.owner.receiveFileInfo(callback(0, { isEnd: false, nextIndex }));
      return 0;
    });
    try {
      await assert.rejects(
        g.owner.listGroupFiles('123', { maxPages: 1 }),
        nextIndex ? /budget/ : /advance/,
      );
    } finally {
      g.owner.close();
    }
  }
});

test('early timer wakeup retains the active page until its monotonic deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timers = t.mock.method(globalThis, 'setTimeout');
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const f = fixture();
  try {
    const first = f.owner.getGroupFilePage('123');
    const queued = f.owner.getGroupFilePage('123');
    let settled = false;
    const outcomes = Promise.allSettled([first, queued]).then((value) => {
      settled = true;
      return value;
    });
    now = 5099.5;
    // Run only the active timer callback: Node drains its microtasks before the
    // next due timer; a single mock tick would run both callbacks as one batch.
    const wakeup = timers.mock.calls[0].arguments[0] as () => void;
    wakeup();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.calls.length, 1, 'an early wakeup must not free the dispatch lane');
    assert.equal(settled, false, 'the monotonic deadline has not elapsed');
    now = 5100;
    const expiry = timers.mock.calls.at(-1)!.arguments[0] as () => void;
    expiry();
    const result = await outcomes;
    for (const outcome of result) {
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') assert.match(String(outcome.reason), /timed out/);
    }
    assert.equal(f.calls.length, 1, 'queued time consumes the same page deadline');
  } finally {
    f.owner.close();
  }
});

test('no callback uses actual fixed five-second deadline, queued time included', async () => {
  const f = fixture();
  const originalNow = performance.now;
  const start = originalNow.call(performance);
  try {
    // Give both requests the same monotonic deadline, avoiding a legitimate
    // one-millisecond dispatch window between otherwise adjacent requests.
    performance.now = () => start;
    const first = f.owner.getGroupFilePage('123');
    const queued = f.owner.getGroupFilePage('123');
    performance.now = originalNow;
    await Promise.all([assert.rejects(first, /timed out/), assert.rejects(queued, /timed out/)]);
    assert.ok(performance.now() - start >= 4900);
    assert.equal(f.calls.length, 1);
  } finally {
    performance.now = originalNow;
    f.owner.close();
  }
});

test('worker token ledger has bounded non-evicting budget', () => {
  const history = new GroupFilePageHistory();
  for (let token = 0; token < 100_000; token++) {
    const lease = history.acquire();
    history.reserve(lease, token);
    history.release(lease);
  }
  assert.throws(() => history.acquire(), /budget/);
  assert.throws(() => history.acquire(), /quarantined/);
});

test('request cancellation retains known token without quarantining future unique requests', async () => {
  const history = new GroupFilePageHistory();
  const a = fixture(history);
  const cancellation = new AbortController();
  try {
    const pending = a.owner.getGroupFilePage('123', {}, cancellation.signal);
    cancellation.abort();
    await assert.rejects(pending, /cancelled/);
    a.owner.receiveFileInfo(callback(0));
    a.owner.close();
    const b = fixture(history);
    b.setDispatch(() => {
      b.owner.receiveFileInfo(callback(1));
      return 1;
    });
    try {
      assert.equal((await b.owner.getGroupFilePage('123')).groupId, '123');
    } finally {
      b.owner.close();
    }
  } finally {
    a.owner.close();
  }
});

test('close on native stack before returned token quarantines worker; caller params remain captured', async () => {
  const history = new GroupFilePageHistory();
  const f = fixture(history);
  f.setDispatch(() => {
    f.owner.close();
    return 0;
  });
  await assert.rejects(f.owner.getGroupFilePage('123'), /closed/);
  const next = fixture(history);
  try {
    await assert.rejects(next.owner.getGroupFilePage('123'), /quarantined/);
    assert.equal(next.calls.length, 0);
  } finally {
    next.owner.close();
  }
  const g = fixture();
  const options = { fileCount: 7, startIndex: 2 };
  try {
    const pending = g.owner.getGroupFilePage('123', options);
    options.fileCount = 99;
    options.startIndex = 33;
    g.owner.receiveFileInfo(callback(0));
    const page = await pending;
    assert.equal(page.fileCount, 7);
    assert.equal(page.startIndex, 2);
  } finally {
    g.owner.close();
  }
});

test('request abort during callback capture cannot publish or begin a new listing page', async () => {
  const f = fixture();
  const cancellation = new AbortController();
  f.setDispatch(() => {
    f.owner.receiveFileInfo(callback(0, { isEnd: false, nextIndex: 2 }));
    cancellation.abort();
    return 0;
  });
  try {
    await assert.rejects(
      f.owner.listGroupFiles('123', {}, cancellation.signal),
      /cancelled|abort/i,
    );
    assert.equal(f.calls.length, 1);
  } finally {
    f.owner.close();
  }
});

test('expired active callback cannot beat timer; expired startup getter cannot dispatch', async () => {
  const f = fixture();
  const originalNow = performance.now;
  try {
    const pending = f.owner.getGroupFilePage('123');
    const late = originalNow.call(performance) + 6000;
    performance.now = () => late;
    f.owner.receiveFileInfo(callback(0));
    performance.now = originalNow;
    await assert.rejects(pending, /timed out/);
  } finally {
    performance.now = originalNow;
    f.owner.close();
  }
  let calls = 0;
  const controller = new AbortController();
  const owner = createGroupFilePages({
    signal: controller.signal,
    history: new GroupFilePageHistory(),
    supportsFilePage: () => true,
    getFilePageService: () => ({
      get getGroupFileList() {
        const late = originalNow.call(performance) + 6000;
        performance.now = () => late;
        return () => {
          calls++;
          return 0;
        };
      },
    }),
  });
  try {
    await assert.rejects(owner.getGroupFilePage('123'), /timed out/);
    assert.equal(calls, 0);
  } finally {
    performance.now = originalNow;
    owner.close();
  }
});

test('successful callback followed by same-turn abort/close cannot publish a late page', async () => {
  for (const action of ['account', 'request', 'close'] as const) {
    const f = fixture();
    const request = new AbortController();
    try {
      const pending = f.owner.getGroupFilePage('123', {}, request.signal);
      f.owner.receiveFileInfo(callback(0));
      if (action === 'account') f.controller.abort(new Error('account stopped'));
      else if (action === 'request') request.abort(new Error('request stopped'));
      else f.owner.close();
      await assert.rejects(pending, /stopped|closed/);
    } finally {
      f.owner.close();
    }
  }
});

test('GroupFiles facade checks its own close after page owner publication', async () => {
  const signal = new AbortController().signal;
  const files = createGroupFiles({
    signal,
    awaitAlive: async (value) => value,
    getFileCountService: () => {
      throw new Error('Unexpected count acquisition');
    },
    getFolderCreationService: () => {
      throw new Error('Unexpected creation acquisition');
    },
    getFolderDeletionService: () => {
      throw new Error('Unexpected deletion acquisition');
    },
    supportsFileCount: () => false,
    supportsFolderCreation: () => false,
    supportsFolderDeletion: () => false,
    history: new GroupFilePageHistory(),
    supportsFilePage: () => true,
    getFilePageService: () => ({ getGroupFileList: () => 0 }),
  });
  try {
    const pending = files.getGroupFilePage('123');
    files.receiveFileInfo(callback(0));
    await Promise.resolve();
    files.close();
    await assert.rejects(pending, /closed/);
  } finally {
    files.close();
  }
});

test('wall-clock rollback cannot extend the elapsed callback deadline', async () => {
  const f = fixture();
  const originalWallNow = Date.now;
  const originalElapsedNow = performance.now;
  try {
    const pending = f.owner.getGroupFilePage('123');
    const elapsed = originalElapsedNow.call(performance) + 6000;
    const wall = originalWallNow() - 60_000;
    Date.now = () => wall;
    performance.now = () => elapsed;
    f.owner.receiveFileInfo(callback(0));
    await assert.rejects(pending, /timed out/);
    assert.equal(f.calls.length, 1);
  } finally {
    Date.now = originalWallNow;
    performance.now = originalElapsedNow;
    f.owner.close();
  }
});
