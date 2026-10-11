import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const lifecycleUrl = new URL('../src/runtime/client-lifecycle.ts', import.meta.url).href;

/** @param {'configured'|'restore'|'cancel'} phase @param {'error'|'opaque'|'none'} observer @param {'throw'|'warn'} mode */
function runChild(phase, observer, mode) {
  const source = `
    import { EventEmitter } from 'node:events';
    import { ClientLifecycle } from ${JSON.stringify(lifecycleUrl)};
    const phase=${JSON.stringify(phase)}, observer=${JSON.stringify(observer)};
    const primary=new Error('controlled operation failure');
    let dispatches=0, notifications=0, primaryIdentity=false, accessorReads=0, active=false;
    const secondary=observer==='error'?new Error('controlled observer failure'):Object.defineProperties({}, {
      message:{get(){accessorReads++;throw Error('must not read message');}},
      toString:{get(){accessorReads++;throw Error('must not coerce');}}
    });
    const snapshot=(extra={})=>({phase,dispatches,notifications,primaryIdentity,accessorReads,...extra});
    process.on('uncaughtExceptionMonitor',(error,origin)=>console.log(JSON.stringify(snapshot({origin,message:error.message}))));
    const worker=new EventEmitter();
    Object.assign(worker,{connected:true,exitCode:null,signalCode:null,
      send(message,callback){
        if(message.method==='login'&&active){dispatches++;callback(primary);return true;}
        callback(null);
        if(message.method==='close')queueMicrotask(()=>{worker.emit('message',{id:message.id,result:null});worker.exitCode=0;worker.connected=false;worker.emit('exit',0,null);});
        return true;
      },kill(){worker.exitCode=0;worker.connected=false;worker.emit('exit',0,null);return true;}
    });
    const lifecycle=new ClientLifecycle({worker,timeout:1000,defaultLogin:{method:'quick',uin:'123'},
      ...(phase==='restore'?{restart:{spawn(){dispatches++;throw primary;},payload:{}},autoReconnect:{delayMs:1,maxAttempts:1}}:{}),
      emit(){},exportsUpdated(){},forward(event,error){
        if(event!== (phase==='restore'?'reconnect-error':'loginError'))return;
        notifications++;primaryIdentity=error===primary;
        if(observer!=='none')throw secondary;
      }
    });
    if(phase==='restore'){
      const login=lifecycle.login({method:'quick',uin:'123'});
      worker.emit('message',{event:'ready',payload:{uin:'123',uid:'u_fixture'}});
      worker.emit('message',{id:1,result:{uin:'123',uid:'u_fixture'}});
      await login;active=true;
      worker.emit('message',{event:'disconnected',payload:{retryable:true}});
    }else{
      active=true;lifecycle.scheduleDefaultLogin();
      if(phase==='cancel')await lifecycle.close();
    }
    setTimeout(async()=>{await lifecycle.close();console.log(JSON.stringify(snapshot({continued:true})));},100);
  `;
  const result = spawnSync(
    process.execPath,
    ['--unhandled-rejections=' + mode, '--input-type=module', '--eval', source],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.error, undefined, 'child must finish within bounded deadline');
  assert.equal(result.signal, null);
  return result;
}

for (const [phase, observer, mode] of [
  ['configured', 'error', 'throw'],
  ['configured', 'error', 'warn'],
  ['configured', 'opaque', 'warn'],
  ['restore', 'error', 'throw'],
  ['restore', 'error', 'warn'],
  ['restore', 'opaque', 'warn'],
]) {
  await test(`${phase} ${observer} notification failure is deferred fatal under ${mode}`, () => {
    const child = runChild(
      /** @type {'configured'|'restore'} */ (phase),
      /** @type {'error'|'opaque'} */ (observer),
      /** @type {'throw'|'warn'} */ (mode),
    );
    assert.equal(child.status, 1);
    assert.deepEqual(JSON.parse(child.stdout.trim()), {
      phase,
      dispatches: 1,
      notifications: 1,
      primaryIdentity: true,
      accessorReads: 0,
      origin: 'uncaughtException',
      message: observer === 'error' ? 'controlled observer failure' : 'Kernel request failed',
    });
    assert.equal(child.stderr.includes('UnhandledPromiseRejectionWarning'), false);
  });
}

for (const phase of ['configured', 'restore', 'cancel']) {
  await test(`${phase} without escaping notification finishes normally without replay`, () => {
    const child = runChild(/** @type {'configured'|'restore'|'cancel'} */ (phase), 'none', 'warn');
    assert.equal(child.status, 0);
    assert.deepEqual(JSON.parse(child.stdout.trim()), {
      phase,
      dispatches: phase === 'cancel' ? 0 : 1,
      notifications: phase === 'cancel' ? 0 : 1,
      primaryIdentity: phase !== 'cancel',
      accessorReads: 0,
      continued: true,
    });
    assert.equal(child.stderr.includes('UnhandledPromiseRejectionWarning'), false);
  });
}
