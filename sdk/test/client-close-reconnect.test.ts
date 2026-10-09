import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {ChildProcess} from 'node:child_process';
import {QQClient} from '../src/index.ts';
class Worker extends EventEmitter {
 connected=true;exitCode:number|null=null;signalCode=null;stdout=new EventEmitter();stderr=new EventEmitter();requests:any[]=[];kills=0;
 send(value:any,cb:(error:Error|null)=>void){this.requests.push(value);cb(null);if(value.method==='close')queueMicrotask(()=>this.emit('message',{id:value.id,result:null}));}
 kill(){this.kills++;return true;}
 exit(){this.connected=false;this.exitCode=0;this.emit('exit',0,null);}
}
const cast=(worker:Worker)=>worker as unknown as ChildProcess;
test('close during retirement waits for actual exit and cancels reconnect without an ignored close RPC',async()=>{
 const previous=new Worker();let spawns=0;const client=new QQClient(cast(previous),500,{method:'restore'},{spawn(){spawns++;return cast(new Worker());},payload:{}});
 const reconnect=assert.rejects(client.reconnect(),/closed during reconnect/);
 await new Promise(resolve=>setImmediate(resolve));
 const close=client.close();assert.equal(close,client.close());let finished=false;void close.then(()=>{finished=true;},()=>{});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);assert.equal(previous.requests.some(request=>request.method==='close'),false);
 previous.exit();await close;await reconnect;assert.equal(spawns,0);assert.equal(client.state,'closed');
});
test('close while replacement init is pending stops replacement and never starts login',async()=>{
 const previous=new Worker(),replacement=new Worker();previous.exit();
 const client=new QQClient(cast(previous),5000,{method:'restore'},{spawn(){return cast(replacement);},payload:{}});
 const reconnect=assert.rejects(client.reconnect(),/closed|exited/);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(replacement.requests[0].method,'init');
 const close=client.close();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(client.state,'closing');replacement.exit();await close;await reconnect;
 const init=replacement.requests[0];replacement.emit('message',{id:init.id,result:{exports:[]}});replacement.emit('message',{event:'ready',payload:{uin:'late',uid:'late'}});
 assert.equal(client.state,'closed');assert.equal(client.account,undefined);assert.equal(replacement.requests.some(request=>request.method==='login'),false);
});
test('unresponsive retiring worker reports real cleanup failure instead of claiming closure',async()=>{
 const previous=new Worker();let spawns=0;const client=new QQClient(cast(previous),500,{method:'restore'},{spawn(){spawns++;return cast(new Worker());},payload:{}});
 const reconnect=assert.rejects(client.reconnect(),/did not exit/);
 await new Promise(resolve=>setImmediate(resolve));
 const close=client.close();assert.equal(close,client.close());await assert.rejects(close,/did not exit after shutdown/);await reconnect;
 assert.equal(client.state,'failed');assert.equal(spawns,0);assert.equal(previous.requests.length,0);assert.ok(previous.kills>=2);
});
