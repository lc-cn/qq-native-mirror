import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {observeWatchFailures} from '../src/cli.ts';
import type {QQClient,ClientOptions} from '../src/index.ts';

// The exact helper called by main is used with a fake connected watch client.
// No createClient override, SDK worker, native initialization or timers.
for(const policy of [true,{maxAttempts:2},{maxAttempts:2,delayMs:0}])test('watch observer accepts enabled config and only continues for explicitly retryable disconnect',()=>{
 const client=new EventEmitter(),errors:Error[]=[];
 const remove=observeWatchFailures(client as QQClient,policy,error=>errors.push(error));
 client.emit('disconnected',{retryable:true,kind:'transport'});assert.deepEqual(errors,[]);
 client.emit('disconnected',{retryable:false,kind:'unknown'});assert.equal(errors.length,1);assert.match(errors[0].message,/disconnected/);
 remove();assert.equal(client.listenerCount('disconnected'),0);client.emit('disconnected',{retryable:false});assert.equal(errors.length,1);
});
for(const policy of [false,undefined])test('watch observer with disabled config stops even explicitly retryable disconnect',()=>{
 const client=new EventEmitter(),errors:Error[]=[];const remove=observeWatchFailures(client as QQClient,policy,error=>errors.push(error));
 client.emit('disconnected',{retryable:true});assert.equal(errors.length,1);remove();
});
test('object policy does not restore unknown or forced-offline events and cleanup removes all listeners',()=>{
 const client=new EventEmitter(),errors:Error[]=[];const remove=observeWatchFailures(client as QQClient,{maxAttempts:2},error=>errors.push(error));
 client.emit('disconnected',undefined);client.emit('kicked',{kind:'forced',retryable:false});client.emit('logout');
 assert.equal(errors.length,3);assert.match(errors[0].message,/disconnected/);assert.match(errors[1].message,/kicked/);assert.match(errors[2].message,/logged out/);
 remove();for(const event of ['disconnected','kicked','logout','terminated','reconnect-error'])assert.equal(client.listenerCount(event),0);
});
for(const policy of [null,[],{maxAttempts:0},{delayMs:-1},{maxAttempts:1.5},'true'])test('illegal watch reconnect config installs no observer',()=>{
 const client=new EventEmitter();assert.throws(()=>observeWatchFailures(client as QQClient,policy as ClientOptions['autoReconnect'],()=>{}),/Invalid autoReconnect policy/);assert.equal(client.eventNames().length,0);
});
for(const policy of [null,{maxAttempts:0},{delayMs:-1}])test('actual CLI rejects illegal object/null policy before native path or account directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cli-watch-preflight-'));
 const dataDir=join(root,'account-must-not-exist'),config=join(root,'config.json');
 try{
  await writeFile(config,JSON.stringify({dataDir,wrapperPath:join(root,'explicit-nonexistent-wrapper.node'),version:{clientVersion:'fixture-version',appId:'fixture-app',qua:'fixture-qua'},autoReconnect:policy}));
  // Explicit local wrapper excludes mirror/catalog fallback. Policy rejection
  // must precede even examining that nonexistent wrapper or creating dataDir.
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'watch','--config',config],{encoding:'utf8',timeout:5000});
  assert.equal(result.error,undefined);assert.equal(result.status,1);
  assert.match(result.stderr,/Invalid autoReconnect policy/);assert.doesNotMatch(result.stderr,/ENOENT|wrapper|catalog|manifest|dlopen/);
  assert.equal(result.stdout,'');await assert.rejects(stat(dataDir),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
