import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Real worker IPC; only kernel bootstrap/dlopen and HTTP are synthetic. */
export async function verifyWorkerReadCancellation({
  QQClient,
  workerPath,
  kernelPath,
  nativeServicesPath,
}) {
  const directory = await mkdtemp(join(tmpdir(), 'qq-read-cancel-'));
  const fixture = join(directory, 'kernel.mjs');
  const hook = join(directory, 'hook.mjs');
  await writeFile(
    fixture,
    `
import {createNativeServices} from ${JSON.stringify(pathToFileURL(await realpath(nativeServicesPath)).href)};
const report=(event)=>process.send?.({fixture:event});
let releaseTicket, mode='ticket', fetches=0, closes=0;
process.on('message',m=>{if(m?.fixtureControl==='release-ticket'){releaseTicket?.({result:0,clientKey:'synthetic-ticket'});setImmediate(()=>report('released:'+fetches));}if(m?.fixtureControl==='mode-http'){mode='http';report('mode-http');}if(m?.fixtureControl==='mode-success'){mode='success';report('mode-success');}});
globalThis.fetch=async(url,init)=>{
 fetches++;
 if(String(url).startsWith('https://ssl.ptlogin2.qq.com/'))return new Response(null,{headers:{'set-cookie':'skey=abc; Path=/'}});
 report('page:'+new URL(url).searchParams.get('page_start'));
 if(mode==='http'){report('http-stalled');return new Promise((_,reject)=>{const abort=()=>{report('http-aborted');reject(Error('synthetic abort'));};if(init.signal.aborted)abort();else init.signal.addEventListener('abort',abort,{once:true});});}
 return Response.json({retcode:0,data:{msg_list:[],is_end:true,group_role:2,config_page_url:''}});
};
export function createKernel(_native,_options,emit){
 const services=createNativeServices({session:{getTicketService:()=>({forceFetchClientKey:()=>{if(mode==='ticket'){report('ticket-stalled');return new Promise(resolve=>releaseTicket=resolve);}return Promise.resolve({result:0,clientKey:'synthetic-ticket'});}}),getTipOffService:()=>({getPskey:async()=>({result:0,domainPskeyMap:new Map([['qun.qq.com','synthetic-key']])})}),getBuddyService:()=>({addKernelBuddyListener(){},removeKernelBuddyListener(){}}),getMsgService:()=>({addKernelMsgListener(){}}),getGroupService:()=>({addKernelGroupListener(){}})},version:'fixture',identity:{userId:'789'},events:{emit(){}}});
 return {async prepare(){},async login(){const account={uin:'789',uid:'u_fixture'};emit('ready',account);return account;},invokeOperation(method,payload,signal){return services.invokeOperation(method,payload,signal);},async close(){closes++;services.close();report('closed:'+closes);}};
}
`,
  );
  await writeFile(
    hook,
    `import {registerHooks} from 'node:module';process.dlopen=()=>{};registerHooks({resolve(specifier,context,next){const result=next(specifier,context);if(result.url===${JSON.stringify(pathToFileURL(await realpath(kernelPath)).href)})return {url:${JSON.stringify(pathToFileURL(fixture).href)},shortCircuit:true};return result;}});`,
  );
  const worker = fork(await realpath(workerPath), [], {
    cwd: directory,
    execArgv: ['--import', pathToFileURL(hook).href],
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  worker.stdout.resume();
  worker.stderr.resume();
  const seen = [];
  const waiting = new Map();
  worker.on('message', (message) => {
    if (typeof message?.fixture !== 'string') return;
    seen.push(message.fixture);
    waiting.get(message.fixture)?.();
  });
  const until = (event) => {
    if (seen.includes(event)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(event);
        reject(Error('Missing fixture event: ' + event));
      }, 3000);
      waiting.set(event, () => {
        clearTimeout(timer);
        waiting.delete(event);
        resolve();
      });
    });
  };
  const client = new QQClient(worker, 5000);
  try {
    await client.request('init', {
      options: {
        dataDir: join(directory, 'account'),
        wrapperPath: join(directory, 'fixture.node'),
        version: { clientVersion: 'fixture', appId: 'fixture', qua: 'fixture' },
        preloadLibraries: [],
      },
    });
    await client.login({ method: 'restore', uin: '789' });
    const first = assert.rejects(
      client.request('getGroupEssencePage', { groupId: '123' }, 150),
      /timed out/,
    );
    await until('ticket-stalled');
    await first;
    worker.send({ fixtureControl: 'release-ticket' });
    await until('released:0');
    worker.send({ fixtureControl: 'mode-http' });
    await until('mode-http');
    const second = assert.rejects(
      client.request('listGroupEssenceMessages', { groupId: '123', options: { maxPages: 2 } }, 150),
      /timed out/,
    );
    await until('http-stalled');
    await second;
    await until('http-aborted');
    worker.send({ control: 'cancel-read', id: 999999 });
    worker.send({ fixtureControl: 'mode-success' });
    await until('mode-success');
    assert.deepEqual(await client.getGroupEssencePage('123'), {
      groupId: '123',
      pageStart: 0,
      pageLimit: 50,
      messages: [],
      isEnd: true,
      groupRole: 2,
    });
    assert.deepEqual(
      seen.filter((event) => event.startsWith('page:')),
      ['page:0', 'page:0'],
      'cancelled full traversal never requests its next page',
    );
    assert.equal(
      seen.some((event) => event.startsWith('closed:')),
      false,
      'request cancellation must not close Session',
    );
    await client.close();
    return {
      workerReadCancellation: true,
      stalledTicketNoHttp: true,
      httpAborted: true,
      otherReadSucceeded: true,
      unknownCancelHarmless: true,
      accountUsed: false,
      nativeExecuted: false,
      realHttp: false,
    };
  } finally {
    try {
      await client.close();
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  }
}
