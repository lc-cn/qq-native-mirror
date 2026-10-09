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
