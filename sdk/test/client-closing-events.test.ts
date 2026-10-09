import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {ChildProcess} from 'node:child_process';
import {QQClient} from '../src/index.ts';
class Worker extends EventEmitter {
 connected=true;exitCode:number|null=null;signalCode=null;stdout=new EventEmitter();stderr=new EventEmitter();requests:any[]=[];
 send(value:any,callback:(error:Error|null)=>void){this.requests.push(value);callback(null);}
 kill(){return true;}
 exit(){this.connected=false;this.exitCode=0;this.emit('exit',0,null);}
}
for(const event of ['ready','disconnected','logout','kicked']){
 test(`close ignores late ${event} while worker is alive and shutdown response is pending`,async()=>{
  const worker=new Worker(),client=new QQClient(worker as unknown as ChildProcess,500);
  const close=client.close();let observed=0;client.on(event,()=>observed++);
  try{
   worker.emit('message',{event,payload:event==='ready'?{uin:'123',uid:'late'}:{retryable:true}});
   assert.equal(client.state,'closing');assert.equal(client.account,undefined);assert.equal(observed,0);
   await assert.rejects(client.listFriends(),/closed|not online/);assert.deepEqual(worker.requests.map(request=>request.method),['close']);
  }finally{
   worker.emit('message',{id:worker.requests[0].id,result:null});await new Promise(resolve=>setImmediate(resolve));worker.exit();await close;
  }
  assert.equal(client.state,'closed');assert.equal(client.account,undefined);
 });
}
