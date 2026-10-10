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
