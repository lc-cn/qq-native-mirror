import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { QQClient } from '../src/index.ts';

class Worker extends EventEmitter {
  connected = true;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  requests: any[] = [];
  send(value: any, callback: (error: Error | null) => void) {
    this.requests.push(value); callback(null);
    if (value.method === 'close') queueMicrotask(() => this.emit('message', { id: value.id, result: null }));
  }
  kill() { this.connected = false; queueMicrotask(() => this.emit('exit', 0, null)); return true; }
}

test('public batch lookup captures input before IPC and close rejects the pending request', async () => {
  const worker = new Worker(), client = new QQClient(worker as unknown as ChildProcess, 500);
  try {
    await assert.rejects(client.getMessages({ type: 'group', groupId: '123' }, ['1']), /not online/);
    worker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_self' } });
    await assert.rejects(client.getMessages({ type: 'group', groupId: '123' }, ['1', '1']), /duplicate/);
    assert.equal(worker.requests.length, 0);
    const ids = ['900719925474099312345', '2'], peer = { type: 'group' as const, groupId: '123' };
    const request = client.getMessages(peer, ids); ids[0] = '999'; peer.groupId = '999';
    const sent = worker.requests.at(-1);
    assert.deepEqual({ method: sent.method, peer: sent.peer, messageIds: sent.messageIds }, { method: 'getMessages', peer: { type: 'group', groupId: '123' }, messageIds: ['900719925474099312345', '2'] });
    worker.emit('message', { id: sent.id, result: [undefined, undefined] });
    assert.deepEqual(await request, [undefined, undefined]);
    const pending = client.getMessages({ type: 'group', groupId: '123' }, ['1']);
    const rejected = assert.rejects(pending, /closed/);
    await client.close(); await rejected;
    assert.equal(worker.requests.filter(r => r.method === 'getMessages').length, 2);
  } finally { await client.close(); }
});

test('public client exposes friend metadata and suppresses delivery after close', async () => {
  const worker = new Worker(), client = new QQClient(worker as unknown as ChildProcess, 500);
  const events: unknown[] = [], update = { categories: [{ categoryId: 0, name: '', memberCount: 0, friends: [] }] };
  client.on('friend-list-updated', value => events.push(value));
  worker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_self' } });
  worker.emit('message', { event: 'friend-list-updated', payload: update });
  assert.deepEqual(events, [update]); assert.equal(client.state, 'online');
  await client.close();
  worker.emit('message', { event: 'friend-list-updated', payload: update });
  assert.equal(events.length, 1);
});

test('public client forwards typed group metadata without changing account state and suppresses late events', async () => {
  const worker = new Worker(), client = new QQClient(worker as unknown as ChildProcess, 500);
  const events: unknown[] = [];
  client.on('group-list-updated', update => events.push(update));
  client.on('group-members-updated', update => events.push(update));
  const list = { kind: 'removed', groups: [{ groupId: '123' }] };
  const members = { groupId: '123', source: 'remote', members: [{ uid: 'u', deleted: true }] };
  worker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_self' } });
  worker.emit('message', { event: 'group-list-updated', payload: list });
  worker.emit('message', { event: 'group-members-updated', payload: members });
  assert.deepEqual(events, [list, members]);
  assert.equal(client.state, 'online'); assert.equal(client.account?.uin, '456');
  await client.close();
  worker.emit('message', { event: 'group-list-updated', payload: list });
  worker.emit('message', { event: 'group-members-updated', payload: members });
  assert.equal(events.length, 2);
});

test('setSignature validates JavaScript input before IPC and preserves online-only error semantics', async () => {
  const worker = new Worker(), client = new QQClient(worker as unknown as ChildProcess, 500);
  try {
    await assert.rejects(client.setSignature('explicit signature'), /not online/);
    assert.equal(worker.requests.length, 0);
    worker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_fixture' } });
    for (const text of [undefined, null, 42, {}, ['signature']]) {
      await assert.rejects(client.setSignature(text as unknown as string), /must be a string/);
    }
    assert.equal(worker.requests.length, 0, 'invalid input never reaches the worker');
    const clear = client.setSignature('');
    const request = worker.requests.at(-1);
    assert.deepEqual({ method: request.method, text: request.text }, { method: 'setSignature', text: '' });
    worker.emit('message', { id: request.id, result: undefined });
    assert.equal(await clear, undefined);
    const update = client.setSignature('保持空格 ✓  ');
    assert.equal(worker.requests.at(-1).text, '保持空格 ✓  ');
    worker.emit('message', { id: worker.requests.at(-1).id, error: { message: 'Native signature update failed', code: 23 } });
    await assert.rejects(update, { operation: 'setSignature', code: 23 });
    assert.equal(worker.requests.length, 2, 'failed update is not replayed');
  } finally { await client.close(); }
});

test('getMessage uses the public online-only RPC and preserves absent results and native error codes', async () => {
  const worker = new Worker(), client = new QQClient(worker as unknown as ChildProcess, 500);
  const peer = { type: 'group' as const, groupId: '123' }, messageId = '900719925474099312345';
  try {
    await assert.rejects(client.getMessage(peer, messageId), /not online/);
    assert.equal(worker.requests.length, 0);
    worker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_fixture' } });
    await assert.rejects(client.getMessage(peer, 123 as unknown as string), /numeric string/);
    assert.equal(worker.requests.length, 0, 'invalid JavaScript input does not reach IPC');
    const absent = client.getMessage(peer, messageId);
    const request = worker.requests.at(-1);
    assert.deepEqual({ method: request.method, peer: request.peer, messageId: request.messageId }, { method: 'getMessage', peer, messageId });
    worker.emit('message', { id: request.id, result: undefined });
    assert.equal(await absent, undefined);
    const rejected = client.getMessage(peer, messageId);
    worker.emit('message', { id: worker.requests.at(-1).id, error: { message: 'Native query failed', code: 23 } });
    await assert.rejects(rejected, { operation: 'getMessage', code: 23 });
    assert.equal(worker.requests.length, 2);
  } finally { await client.close(); }
});

test('synchronous IPC send failure clears the login timer instead of killing a later request', async () => {
  class ThrowOnce extends Worker {
    first=true;
    override send(value:any,callback:(error:Error|null)=>void) {
      if(this.first){this.first=false;throw new Error('IPC serialization failed');}
      super.send(value,callback);
      if(value.method==='login') queueMicrotask(()=>{
        this.emit('message',{event:'ready',payload:{uin:'123',uid:'u_123'}});
        this.emit('message',{id:value.id,result:{uin:'123',uid:'u_123'}});
      });
    }
  }
  const worker=new ThrowOnce(),client=new QQClient(worker as unknown as ChildProcess,5);
  try {
    await assert.rejects(client.login({method:'restore',uin:'123'}),/IPC serialization/);
    await client.login({method:'restore',uin:'123'});
    await new Promise(resolve=>setTimeout(resolve,15));
    assert.equal(worker.connected,true);assert.equal(client.state,'online');
    assert.equal(client.account?.uin,'123');
  }finally{await client.close();}
});

test('login timeout retires its worker and rejects late account readiness', async () => {
  const worker=new Worker(),client=new QQClient(worker as unknown as ChildProcess,5);
  const login=client.login({method:'restore',uin:'123'});
  await assert.rejects(login,/login timed out/);
  assert.equal(worker.connected,false);
  worker.emit('message',{event:'ready',payload:{uin:'123',uid:'u_late'}});
  assert.equal(client.state,'failed');assert.equal(client.account,undefined);
  await assert.rejects(client.login({method:'restore',uin:'123'}),/closed/);
  await client.close();
});

test('ready event consumers cannot mutate the stored account identity', async () => {
  const worker=new Worker(),client=new QQClient(worker as unknown as ChildProcess,500);
  try {
    client.on('ready',account=>{account.uin='999';account.uid='u_changed';});
    const payload={uin:'123',uid:'u_original'};
    worker.emit('message',{event:'ready',payload});
    payload.uin='888';
    assert.deepEqual(client.account,{uin:'123',uid:'u_original'});
    assert.deepEqual(await client.login({method:'restore',uin:'123'}),{uin:'123',uid:'u_original'});
    await assert.rejects(client.login({method:'restore',uin:'999'}),/different account/);
  } finally {await client.close();}
});

test('reconnect failure waits for the replacement worker exit before rejecting', async () => {
  let notifyKilled!:()=>void;
  const killed=new Promise<void>(resolve=>{notifyKilled=resolve;});
  class FailedReplacement extends Worker {
    exitCode: number|null=null;
    override send(value:any,callback:(error:Error|null)=>void) {
      super.send(value,callback);
      if(value.method==='init') queueMicrotask(()=>this.emit('message',{id:value.id,error:'initialization failed'}));
    }
    override kill(){this.connected=false;notifyKilled();return true;}
  }
  const old=new Worker(),replacement=new FailedReplacement();
  const client=new QQClient(old as unknown as ChildProcess,500,{method:'restore'}, {spawn:()=>replacement as unknown as ChildProcess,payload:{}});
  let settled=false;
  const rejection=assert.rejects(client.reconnect(),/initialization failed/).then(()=>{settled=true;});
  await killed;
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(settled,false,'a kill request alone is not process cleanup');
  replacement.exitCode=0;replacement.emit('exit',0,null);
  await rejection;
  assert.equal(client.state,'failed');
  await client.close();
});

test('two client instances isolate identical RPC IDs, messages and account termination', async () => {
  const leftWorker=new Worker(),rightWorker=new Worker();
  const left=new QQClient(leftWorker as unknown as ChildProcess,500);
  const right=new QQClient(rightWorker as unknown as ChildProcess,500);
  const leftMessages:unknown[]=[],rightMessages:unknown[]=[];
  left.on('message',message=>leftMessages.push(message));
  right.on('message',message=>rightMessages.push(message));
  try {
    leftWorker.emit('message',{event:'ready',payload:{uin:'123',uid:'u_left'}});
    rightWorker.emit('message',{event:'ready',payload:{uin:'456',uid:'u_right'}});
    const a=left.listFriends(),b=right.listFriends();
    assert.equal(leftWorker.requests.at(-1).id,rightWorker.requests.at(-1).id);
    rightWorker.emit('message',{id:rightWorker.requests.at(-1).id,result:['right']});
    leftWorker.emit('message',{id:leftWorker.requests.at(-1).id,result:['left']});
    assert.deepEqual(await a,['left']);assert.deepEqual(await b,['right']);
    leftWorker.emit('message',{event:'message',payload:{messageId:'same-id',account:'left'}});
    rightWorker.emit('message',{event:'message',payload:{messageId:'same-id',account:'right'}});
    assert.deepEqual(leftMessages,[{messageId:'same-id',account:'left'}]);
    assert.deepEqual(rightMessages,[{messageId:'same-id',account:'right'}]);
    leftWorker.emit('message',{event:'kicked',payload:{source:'kicked',kind:'forced',retryable:false,args:[]}});
    assert.equal(left.account,undefined);assert.equal(right.account?.uin,'456');
    assert.equal(right.state,'online');
  } finally { await Promise.all([left.close(),right.close()]); }
});

test('online operations require ready; disconnect clears identity and disables operations', async () => {
  const worker = new Worker();
  const client = new QQClient(worker as unknown as ChildProcess, 500);
  try {
    await assert.rejects(client.listFriends(), /not online/);
    const login = client.login({ method: 'restore' });
    assert.equal(client.state, 'connecting');
    worker.emit('message', { event: 'authenticated', payload: { uin: '123', uid: 'u_123' } });
    await assert.rejects(client.listGroups(), /not online/);
    worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_123' } });
    worker.emit('message', { id: worker.requests[0].id, result: { uin: '123', uid: 'u_123' } });
    await login;
    assert.equal(client.state, 'online');
    const friends = client.listFriends();
    worker.emit('message', { id: worker.requests.at(-1).id, result: [] });
    assert.deepEqual(await friends, []);
    worker.emit('message', { event: 'disconnected' });
    assert.equal(client.account, undefined);
    await assert.rejects(client.listGroups(), /not online/);
  } finally { await client.close(); }
});

test('intentional close rejects outstanding requests and does not report a crash', async () => {
  const worker = new Worker();
  const client = new QQClient(worker as unknown as ChildProcess, 500);
  let crashes = 0;
  client.on('terminated', () => crashes++);
  const pending = assert.rejects(client.request('unanswered'), /closed/);
  await client.close(); await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.state, 'closed');
  assert.equal(crashes, 0);
  await assert.rejects(client.login(), /closed/);
});

test('worker crash rejects pending calls exactly once', async () => {
  const worker = new Worker();
  const client = new QQClient(worker as unknown as ChildProcess, 500);
  let crashes = 0;
  client.on('terminated', () => crashes++);
  const pending = assert.rejects(client.request('unanswered'), /Native worker exited/);
  worker.emit('exit', 1, null);
  worker.emit('error', new Error('late error'));
  await pending;
  assert.equal(client.state, 'failed');
  assert.equal(crashes, 1);
});

test('reconnect replaces worker, rejects interrupted calls and ignores stale events', async () => {
  const previous = new Worker();
  class RestoredWorker extends Worker {
    override send(value: any, callback: (error: Error | null) => void) {
      super.send(value, callback);
      if (value.method === 'init') queueMicrotask(() => this.emit('message', { id: value.id, result: { exports: ['verified-export'] } }));
      if (value.method === 'login') queueMicrotask(() => {
        this.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_123' } });
        this.emit('message', { id: value.id, result: { uin: '123', uid: 'u_123' } });
      });
    }
  }
  const replacement = new RestoredWorker();
  let spawns = 0;
  const client = new QQClient(previous as unknown as ChildProcess, 500, { method: 'restore' }, {
    spawn() { spawns++; return replacement as unknown as ChildProcess; }, payload: { options: {} },
  });
  let crashes = 0;
  client.on('terminated', () => crashes++);
  previous.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_123' } });
  const interrupted = assert.rejects(client.request('pending-write'), /not replayed/);
  const a = client.reconnect(); const b = client.reconnect();
  assert.equal(a, b);
  await interrupted;
  await a;
  assert.equal(client.state, 'online');
  assert.equal(spawns, 1);
  assert.deepEqual(replacement.requests.find(request => request.method === 'login').login, { method: 'restore', uin: '123' });
  assert.deepEqual(client.nativeExports, ['verified-export']);
  previous.emit('message', { event: 'disconnected' });
  previous.emit('error', new Error('stale failure'));
  assert.equal(client.state, 'online'); assert.equal(crashes, 0);
  await client.close();
  await assert.rejects(client.reconnect(), /closed/);
});

test('automatic restore stops on an unknown failure and never replays a message', async () => {
  const worker = new Worker();
  const replacements: Worker[] = [];
  class FailedInit extends Worker {
    override send(value: any, callback: (error: Error | null) => void) {
      super.send(value, callback);
      if (value.method === 'init') queueMicrotask(() => this.emit('message', { id: value.id, error: 'test initialization failure' }));
    }
  }
  const client = new QQClient(worker as unknown as ChildProcess, 500, { method: 'restore' }, {
    spawn() { const next = new FailedInit(); replacements.push(next); return next as unknown as ChildProcess; }, payload: {},
  }, { maxAttempts: 2, delayMs: 0 });
  worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_123' } });
  const finished = new Promise<void>(resolve => {
    let errors = 0;
    client.on('reconnect-error', () => { if (++errors === 1) resolve(); });
  });
  worker.emit('message', { event: 'disconnected', payload: { source: 'msf', kind: 'transport', retryable: true, args: [] } });
  await finished;
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(replacements.length, 1);
  assert(replacements.every(next => next.requests.every(request => request.method === 'init')));
  assert.equal(client.state, 'failed');
  await client.close();
});

test('kicked account is not automatically relogged in', async () => {
  const worker = new Worker(); let spawns = 0;
  const client = new QQClient(worker as unknown as ChildProcess, 500, { method: 'restore' }, {
    spawn() { spawns++; return new Worker() as unknown as ChildProcess; }, payload: {},
  }, { delayMs: 0 });
  worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_123' } });
  worker.emit('message', { event: 'kicked', payload: {} });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(spawns, 0); assert.equal(client.state, 'disconnected');
  await client.close();
});


test('unknown disconnect cancels a previously scheduled restore', async () => {
  const worker = new Worker(); let spawns = 0;
  const client = new QQClient(worker as unknown as ChildProcess, 500, { method: 'restore' }, {
    spawn() { spawns++; return new Worker() as unknown as ChildProcess; }, payload: {},
  }, { delayMs: 5 });
  worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_123' } });
  worker.emit('message', { event: 'disconnected', payload: { source: 'msf', kind: 'transport', retryable: true, args: [] } });
  worker.emit('message', { event: 'disconnected', payload: { source: 'login', kind: 'unknown', retryable: false, args: [] } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(spawns, 0);
  await client.close();
});

test('conflicting login never reuses another account authorization', async () => {
  const worker = new Worker();
  const client = new QQClient(worker as unknown as ChildProcess, 500);
  try {
    const first = client.login({ method: 'restore', uin: '123' });
    assert.equal(client.login({ method: 'restore', uin: '123' }), first);
    await assert.rejects(client.login({ method: 'restore', uin: '456' }), /different login request/);
    await assert.rejects(client.login({ method: 'qr' }), /different login request/);
    assert.equal(worker.requests.length, 1);
    const account = { uin: '123', uid: 'u_123' };
    worker.emit('message', { event: 'ready', payload: account });
    worker.emit('message', { id: worker.requests[0].id, result: account });
    await first;
    await assert.rejects(client.login({ method: 'quick', uin: '456' }), /different account is online/);
    const current = await client.login({ method: 'restore', uin: '123' });
    current.uin = 'changed';
    assert.equal(client.account?.uin, '123');
    assert.equal(worker.requests.length, 1);
  } finally { await client.close(); }
});

test('concurrent close callers await the same shutdown and reject new requests', async () => {
  class DelayedCloseWorker extends Worker {
    send(value: any, callback: (error: Error | null) => void) {
      this.requests.push(value); callback(null);
    }
  }
  const worker = new DelayedCloseWorker();
  const client = new QQClient(worker as unknown as ChildProcess, 500);
  const first = client.close();
  const second = client.close();
  assert.equal(first, second);
  assert.equal(client.state, 'closing');
  let finished = false;
  void second.then(() => { finished = true; });
  await assert.rejects(client.request('listFriends'), /closed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(worker.requests.length, 1);
  worker.emit('message', {id: worker.requests[0].id, result:null});
  await Promise.all([first, second]);
  assert.equal(client.state, 'closed');
  assert.equal(finished, true);
  assert.equal(client.close(), first);
});

test('initialization callback audit retains only bounded shapes and returns defensive copies', async () => {
 const worker=new Worker();
 const client=new QQClient(worker as unknown as ChildProcess,500);
 try {
  for(let i=0;i<2;i++) worker.emit('message',{event:'native-callback',payload:{family:'Session',name:'request',argumentTypes:['object'],secret:'must-not-retain'}});
  const audit=client.nativeCallbackAudit;
  assert.deepEqual(audit,[{family:'Session',name:'request',argumentTypes:['object'],count:2}]);
  audit[0].argumentTypes[0]='mutated';audit[0].count=999;
  assert.equal(client.nativeCallbackAudit[0].count,2);
  assert.equal(client.nativeCallbackAudit[0].argumentTypes[0],'object');
  for(let i=0;i<200;i++) worker.emit('message',{event:'native-callback',payload:{family:'Session',name:`method${i}`,argumentTypes:[]}});
  assert.equal(client.nativeCallbackAudit.length,128);
 } finally {await client.close();}
});

test('offline rejects pending business calls immediately and ignores their late responses', async () => {
 const worker=new Worker();
 const client=new QQClient(worker as unknown as ChildProcess,60000);
 try {
  worker.emit('message',{event:'ready',payload:{uin:'123',uid:'u_123'}});
  const pending=client.listFriends();
  const rejected=assert.rejects(pending,/became offline.*not replayed/);
  const request=worker.requests.at(-1);
  worker.emit('message',{event:'kicked',payload:{source:'kicked',kind:'forced',retryable:false,args:[]}});
  await rejected;
  worker.emit('message',{id:request.id,result:[]});
  assert.equal(client.account,undefined);
  await assert.rejects(client.listGroups(),/not online/);
 }finally{await client.close();}
});

test('login interrupted by disconnect retains disconnected state after rejection', async () => {
 const worker=new Worker();
 const client=new QQClient(worker as unknown as ChildProcess,60000);
 try {
  const rejected=assert.rejects(client.login({method:'qr'}),/became offline/);
  worker.emit('message',{event:'disconnected',payload:{source:'login',kind:'unknown',retryable:false,args:[]}});
  await rejected;
  assert.equal(client.state,'disconnected');
 }finally{await client.close();}
});

test('close resolves only after worker exit, not merely the native close response', async () => {
 class ExitControlledWorker extends Worker { kill() {this.connected=false;return true;} }
 const worker=new ExitControlledWorker();
 const client=new QQClient(worker as unknown as ChildProcess,500);
 let complete=false;
 const closing=client.close().then(()=>{complete=true;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(complete,false);
 assert.equal(client.state,'closing');
 worker.emit('exit',0,null);
 await closing;
 assert.equal(complete,true);
 assert.equal(client.state,'closed');
});

test('a rejected old login cannot clear a replacement login started after disconnect', async () => {
 const worker=new Worker();
 const client=new QQClient(worker as unknown as ChildProcess,500);
 try{
  const old=assert.rejects(client.login({method:'qr'}),/became offline/);
  worker.emit('message',{event:'disconnected',payload:{source:'login',kind:'unknown',retryable:false,args:[]}});
  const replacement=client.login({method:'qr'});
  const id=worker.requests.at(-1).id;
  await old;
  assert.equal(client.state,'connecting');
  assert.equal(client.waitForLogin(),replacement);
  const account={uin:'123',uid:'u_123'};
  worker.emit('message',{event:'ready',payload:account});
  worker.emit('message',{id,result:account});
  assert.deepEqual(await replacement,account);
 }finally{await client.close();}
});


test('worker crash cancels a scheduled automatic restore while explicit reconnect remains available', async () => {
  class ExitedWorker extends Worker { exitCode: number | null = null; signalCode = null; }
  class RestoredWorker extends Worker {
    override send(value: any, callback: (error: Error | null) => void) {
      super.send(value, callback);
      if (value.method === 'init') queueMicrotask(() => this.emit('message', { id: value.id, result: { exports: ['fixture'] } }));
      if (value.method === 'login') queueMicrotask(() => {
        this.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_123' } });
        this.emit('message', { id: value.id, result: { uin: '123', uid: 'u_123' } });
      });
    }
  }
  const worker = new ExitedWorker(), replacement = new RestoredWorker();
  let spawns = 0, terminated = 0;
  const client = new QQClient(worker as unknown as ChildProcess, 500, { method: 'restore' }, {
    spawn() { spawns++; return replacement as unknown as ChildProcess; }, payload: {},
  }, { delayMs: 10, maxAttempts: 1 });
  client.on('terminated', () => terminated++);
  try {
    worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_123' } });
    worker.emit('message', { event: 'disconnected', payload: { retryable: true } });
    worker.connected = false; worker.exitCode = 1; worker.emit('exit', 1, null);
    assert.equal(client.state, 'failed');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(spawns, 0);
    assert.equal(client.state, 'failed'); assert.equal(terminated, 1);
    await client.reconnect();
    assert.equal(spawns, 1); assert.equal(client.state, 'online');
    assert.deepEqual(replacement.requests.find(request => request.method === 'login').login, { method: 'restore', uin: '123' });
  } finally { await client.close(); }
});


test('merged-forward public query defaults first-level parent and captures exact nested context before IPC', async()=>{
 const worker=new Worker(),client=new QQClient(worker as unknown as ChildProcess,500),longId='900719925474099312345';
 try{
  await assert.rejects(client.getForwardMessages({type:'group',groupId:'123'},longId),/not online/);
  worker.emit('message',{event:'ready',payload:{uin:'456',uid:'u_self'}});
  await assert.rejects(client.getForwardMessages({type:'group',groupId:'123'},'not-a-resource-id'),/numeric string/);
  await assert.rejects(client.getForwardMessages({type:'group',groupId:'123'},longId,'bad'),/numeric string/);
  assert.equal(worker.requests.length,0);
  const peer={type:'group' as const,groupId:'123'},first=client.getForwardMessages(peer,longId);peer.groupId='999';
  let request=worker.requests.at(-1);
  assert.deepEqual({peer:request.peer,root:request.rootMessageId,parent:request.parentMessageId},{peer:{type:'group',groupId:'123'},root:longId,parent:longId});
  worker.emit('message',{id:request.id,result:[]});assert.deepEqual(await first,[]);
  const nested=client.getForwardMessages({type:'group',groupId:'123'},longId,'0002');request=worker.requests.at(-1);
  assert.equal(request.rootMessageId,longId);assert.equal(request.parentMessageId,'0002');
  worker.emit('message',{id:request.id,result:[]});await nested;
  assert.equal(worker.requests.length,2);
 }finally{await client.close();}
});

test('resource lookup validates before IPC, preserves the exact reference and closes pending reads without replay',async()=>{
 const worker=new Worker(),client=new QQClient(worker as unknown as ChildProcess,500);
 try{
  await assert.rejects(client.getForwardResource('r'),/not online/);worker.emit('message',{event:'ready',payload:{uin:'456',uid:'u_self'}});
  let coerced=0;for(const bad of ['',null,42,{toString(){coerced++;return 'r';}},'\ud800','界'.repeat(1366)])await assert.rejects(client.getForwardResource(bad as string));
  assert.equal(coerced,0);assert.equal(worker.requests.length,0);
  const exact=' 资源-0001 ';const pending=client.getForwardResource(exact);const request=worker.requests.at(-1);assert.equal(request.method,'getForwardResource');assert.equal(request.resourceId,exact);
  const expected={resourceId:exact,records:[],raw:Buffer.from('opaque')};worker.emit('message',{id:request.id,result:expected});assert.deepEqual(await pending,expected);
  const closing=client.getForwardResource('r');const rejection=assert.rejects(closing,/closed/);await client.close();await rejection;assert.equal(worker.requests.filter(r=>r.method==='getForwardResource').length,2);
 }finally{await client.close();}
});

test('public member query validates group ID before IPC without coercion',async()=>{
 const worker=new Worker(),client=new QQClient(worker as unknown as ChildProcess,500);worker.emit('message',{event:'ready',payload:{uin:'456',uid:'u_self'}});let coercions=0;
 try{for(const id of [undefined,123,'bad','',{toString(){coercions++;return'123';}}])await assert.rejects(async()=>client.getGroupMembers(id as any));assert.equal(worker.requests.length,0);assert.equal(coercions,0);const pending=client.getGroupMembers('00123');const request=worker.requests.at(-1);assert.equal(request.groupId,'00123');worker.emit('message',{id:request.id,result:[]});assert.deepEqual(await pending,[]);}finally{await client.close();}
});

test('group remark public API validates before IPC and preserves empty or exact text',async()=>{
 const worker=new Worker(),client=new QQClient(worker as unknown as ChildProcess,500);worker.emit('message',{event:'ready',payload:{uin:'456',uid:'u_self'}});let coercions=0;
 try{
  for(const [id,remark] of [[undefined,'x'],[123,'x'],['bad','x'],['123',undefined],['123',{toString(){coercions++;return'x';}}]])await assert.rejects(client.setGroupRemark(id as any,remark as any));
  assert.equal(worker.requests.length,0);assert.equal(coercions,0);
  for(const remark of ['', '  exact remark  ']){const pending=client.setGroupRemark('00123',remark);const request=worker.requests.at(-1);assert.equal(request.method,'setGroupRemark');assert.equal(request.groupId,'00123');assert.equal(request.remark,remark);worker.emit('message',{id:request.id,result:undefined});assert.equal(await pending,undefined);}
 }finally{await client.close();}
});

test('public group detail metadata event forwards exact DTO and stops after close',async()=>{
 const worker=new Worker(),client=new QQClient(worker as unknown as ChildProcess,500);const events:any[]=[];client.on('group-info-updated',update=>events.push(update));
 const payload={groupId:'123',name:'fixture',memberCount:2,maxMemberCount:100,ownerUid:'u_owner',ownerUserId:'456',description:'description'};
 worker.emit('message',{event:'group-info-updated',payload});assert.deepEqual(events,[payload]);await client.close();worker.emit('message',{event:'group-info-updated',payload});assert.deepEqual(events,[payload]);
});

test('public friend categories uses dedicated IPC operation and returns category DTO',async()=>{
 const worker=new Worker(),client=new QQClient(worker as unknown as ChildProcess,500);worker.emit('message',{event:'ready',payload:{uin:'456',uid:'u_self'}});
 try{const pending=client.listFriendCategories();const request=worker.requests.at(-1);assert.equal(request.method,'listFriendCategories');const categories=[{categoryId:1,sortId:2,name:'fixture',memberCount:9,onlineCount:4,friends:[]}];worker.emit('message',{id:request.id,result:categories});assert.deepEqual(await pending,categories);}finally{await client.close();}
});
