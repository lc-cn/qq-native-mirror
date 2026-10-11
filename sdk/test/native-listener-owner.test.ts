import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { NativeListenerOwner } from '../src/runtime/native-listener-owner.ts';
import type { NativeObject } from '../src/native/native-object.ts';

test('stable wrappers preserve original override receiver and audit-before-call order', () => {
  const trace: unknown[] = [];
  const overrides = {
    metadata: 7,
    onValue(value: unknown) {
      assert.equal(this, overrides);
      trace.push(value);
      return 9;
    },
  };
  const owner = new NativeListenerOwner({
    isClosed: () => false,
    auditCallback: (info) => trace.push(info),
    dispatch: () => assert.fail('unexpected dispatch'),
  });
  let listener!: NativeObject;
  owner.register({
    family: 'Msg',
    overrides,
    add: (value) => {
      listener = value;
    },
  });
  assert.equal(listener.metadata, 7);
  assert.equal(listener.onValue, listener.onValue);
  assert.equal(listener.onValue(null), 9);
  assert.deepEqual(trace, [{ family: 'Msg', name: 'onValue', argumentTypes: ['null'] }, null]);
});

test('unknown callbacks retain arguments and stable wrapper, with shape-only audit', () => {
  const payload = {};
  let dispatched: unknown;
  const audits: unknown[] = [];
  const owner = new NativeListenerOwner({
    isClosed: () => false,
    auditCallback: (info) => audits.push(info),
    dispatch: (channel, args) => {
      dispatched = [channel, args];
      return 12;
    },
  });
  owner.register({
    family: 'Search',
    overrides: {},
    add: (listener) => {
      assert.equal(listener.onUnknown, listener.onUnknown);
      assert.equal(listener.onUnknown(payload, [], undefined), 12);
    },
  });
  assert.deepEqual(dispatched, ['Search/onUnknown', [payload, [], undefined]]);
  assert.deepEqual(audits, [
    { family: 'Search', name: 'onUnknown', argumentTypes: ['object', 'array', 'undefined'] },
  ]);
});

test('cached callbacks never reacquire a changing native override', () => {
  const trace: unknown[] = [];
  let reads = 0;
  const overrides = {
    get onValue() {
      reads++;
      if (reads !== 1) throw new Error('Callback getter reacquired');
      return function (this: unknown, value: unknown) {
        assert.equal(this, overrides);
        trace.push(value);
        return 'captured';
      };
    },
  };
  const owner = new NativeListenerOwner({
    isClosed: () => false,
    dispatch: () => assert.fail('unexpected dispatch'),
  });
  owner.register({
    family: 'Msg',
    overrides,
    add: (listener) => {
      const captured = listener.onValue;
      assert.equal(listener.onValue, captured);
      assert.equal(captured('first'), 'captured');
      assert.equal(listener.onValue('second'), 'captured');
    },
  });
  assert.equal(reads, 1);
  assert.deepEqual(trace, ['first', 'second']);
});

test('unknown callback cache and ordinary metadata have distinct ownership', () => {
  let reads = 0;
  const channels: string[] = [];
  const overrides = {
    metadata: 1,
    get onUnknown() {
      reads++;
      if (reads !== 1) throw new Error('Unknown callback getter reacquired');
      return undefined;
    },
  };
  const owner = new NativeListenerOwner({
    isClosed: () => false,
    dispatch: (channel) => channels.push(channel),
  });
  owner.register({
    family: 'Search',
    overrides,
    add: (listener) => {
      const callback = listener.onUnknown;
      assert.equal(listener.onUnknown, callback);
      callback();
      listener.onUnknown();
      assert.equal(listener.metadata, 1);
      overrides.metadata = 2;
      assert.equal(listener.metadata, 2);
    },
  });
  assert.equal(reads, 1);
  assert.deepEqual(channels, ['Search/onUnknown', 'Search/onUnknown']);
});

test('a captured callback remains callable after its override slot becomes metadata', () => {
  let calls = 0;
  const overrides = {
    onValue() {
      assert.equal(this, overrides);
      calls++;
    },
  };
  const owner = new NativeListenerOwner({
    isClosed: () => false,
    dispatch: () => assert.fail('unexpected dispatch'),
  });
  owner.register({
    family: 'Msg',
    overrides,
    add: (listener) => {
      const captured = listener.onValue;
      Object.defineProperty(overrides, 'onValue', { value: 7 });
      assert.equal(listener.onValue, captured);
      listener.onValue();
    },
  });
  assert.equal(calls, 1);
});

test('a captured callback slot respects locked metadata Proxy invariants', () => {
  for (const value of [7, undefined, { metadata: true }]) {
    const overrides = { onValue() {} };
    const owner = new NativeListenerOwner({
      isClosed: () => false,
      dispatch: () => assert.fail('unexpected dispatch'),
    });
    owner.register({
      family: 'Msg',
      overrides,
      add: (listener) => {
        assert.equal(typeof listener.onValue, 'function');
        Object.defineProperty(overrides, 'onValue', {
          value,
          configurable: false,
          writable: false,
        });
        assert.equal(listener.onValue, value);
      },
    });
  }
});

test('locking a function slot does not expose an unguarded callback', () => {
  let closed = false;
  let calls = 0;
  const overrides = { onValue: () => calls++ };
  const owner = new NativeListenerOwner({
    isClosed: () => closed,
    dispatch: () => assert.fail('unexpected dispatch'),
  });
  owner.register({
    family: 'Msg',
    overrides,
    add: (listener) => {
      const captured = listener.onValue;
      Object.freeze(overrides);
      assert.throws(() => listener.onValue, TypeError);
      captured();
      closed = true;
      captured();
    },
  });
  assert.equal(calls, 1);
});

test('late cached callback performs neither member nor audit reads or dispatch', () => {
  let closed = false,
    reads = 0,
    audits = 0,
    calls = 0;
  const overrides = {
    get onValue() {
      reads++;
      return () => {
        calls++;
      };
    },
  };
  const owner = new NativeListenerOwner({
    isClosed: () => closed,
    auditCallback: () => {
      audits++;
    },
    dispatch: () => {
      calls++;
    },
  });
  let callback!: () => unknown;
  owner.register({
    family: 'Msg',
    overrides,
    add: (listener) => {
      callback = listener.onValue;
    },
  });
  closed = true;
  assert.equal(callback(), undefined);
  assert.equal(reads, 1);
  assert.equal(audits, 0);
  assert.equal(calls, 0);
});

test('audit reentrancy and exceptions preserve existing callback semantics', () => {
  let closed = false,
    calls = 0;
  const original = new Error('audit failed');
  const owner = new NativeListenerOwner({
    isClosed: () => closed,
    auditCallback: () => {
      closed = true;
    },
    dispatch: () => {
      calls++;
    },
  });
  owner.register({
    family: 'Msg',
    overrides: {
      onValue() {
        calls++;
      },
    },
    add: (listener) => {
      listener.onValue();
    },
  });
  assert.equal(calls, 1);
  const failing = new NativeListenerOwner({
    isClosed: () => false,
    auditCallback: () => {
      throw original;
    },
    dispatch: () => {
      calls++;
    },
  });
  assert.throws(
    () => failing.register({ family: 'Msg', overrides: {}, add: (listener) => listener.onValue() }),
    (error) => error === original,
  );
  assert.equal(calls, 1);
});

test('failed registration is not retried and retains only before-add references', () => {
  const moduleUrl = new URL('../src/runtime/native-listener-owner.ts', import.meta.url).href;
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {queryObjects} from 'node:v8';
    import {NativeListenerOwner} from ${JSON.stringify(moduleUrl)};
    class Before {}; class After {};
    const original = new Error('register failed');
    let calls=0;
    const owner = new NativeListenerOwner({isClosed:()=>false,dispatch:()=>{}});
    function acquire() { for (const [Ctor,retainBeforeAdd] of [[Before,true],[After,false]]) {
      try { owner.register({family:'Msg',overrides:new Ctor(),retainBeforeAdd,add(){calls++;throw original;}}); }
      catch(error) { if(error!==original)throw error; }
    }
    }
    acquire();
    await new Promise(resolve=>setImmediate(resolve));
    const before=queryObjects(Before),after=queryObjects(After);
    if(calls!==2||before!==1||after!==0)throw new Error(JSON.stringify({calls,before,after}));
    owner.register({family:'Msg',overrides:{},add(){}});
    console.log(JSON.stringify({calls,before,after}));
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.deepEqual(JSON.parse(result), { calls: 2, before: 1, after: 0 });
});

test('audit and unknown dispatch preserve plain-function undefined receiver', () => {
  let audits = 0;
  let dispatches = 0;
  const owner = new NativeListenerOwner({
    isClosed: () => false,
    auditCallback: function (this: unknown) {
      assert.equal(this, undefined);
      audits++;
    },
    dispatch: function (this: unknown, channel, args) {
      assert.equal(this, undefined);
      assert.equal(channel, 'Msg/onUnknown');
      assert.deepEqual(args, [1]);
      dispatches++;
    },
  });
  owner.register({ family: 'Msg', overrides: {}, add: (listener) => listener.onUnknown(1) });
  assert.equal(audits, 1);
  assert.equal(dispatches, 1);
});
