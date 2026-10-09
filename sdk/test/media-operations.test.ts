import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDownloadPayload, captureDownloadRequest, downloadAttachment } from '../src/media-operations.ts';

test('download correlates completion, stages native output and exclusively publishes local file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-download-'));
  const destination = join(dir, 'output.txt');
  let request: any;
  try {
    const service = { async downloadRichMedia(options: any) { request = options; await writeFile(options.filePath, 'attachment'); } };
    const result = await downloadAttachment(service, { chatType: 2, peerUid: '123' }, { messageId: '9', elementId: '2', destination },
      async (event, check, invoke, timeout) => {
        assert.equal(event, 'Msg/onRichMediaDownloadComplete'); assert.equal(timeout, 120000);
        await invoke();
        assert.equal(check({ msgId: 'other', msgElementId: '2' }), undefined);
        assert.equal(check({ msgId: '9', msgElementId: 'other' }), undefined);
        return check({ msgId: '9', msgElementId: '2', fileErrCode: '0', fileSrvErrCode: '0', filePath: request.filePath });
      });
    assert.deepEqual(result, { file: destination });
    assert.equal(await readFile(destination, 'utf8'), 'attachment');
    assert.notEqual(request.filePath, destination);
    assert.equal(request.downloadType, 1); assert.equal(request.thumbSize, 0);
    assert.equal(request.msgId, '9'); assert.equal(request.elementId, '2');
    assert.deepEqual(await readdir(dir), ['output.txt']);
  } finally { await rm(dir, { recursive: true }); }
});

test('existing destination rejects before native download and remains unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-download-existing-'));
  const destination = join(dir, 'output'); await writeFile(destination, 'owned');
  let called = false;
  try {
    await assert.rejects(downloadAttachment({ downloadRichMedia() { called = true; } }, { chatType: 1, peerUid: 'u_a' }, { messageId: '9', elementId: '2', destination }, async () => { throw new Error('not expected'); }), /already exists/);
    assert.equal(called, false); assert.equal(await readFile(destination, 'utf8'), 'owned');
  } finally { await rm(dir, { recursive: true }); }
});

test('matching native failure rejects without publishing result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-download-fail-'));
  try {
    await assert.rejects(downloadAttachment({ downloadRichMedia() {} }, { chatType: 2, peerUid: '123' }, { messageId: '9', elementId: '2', destination: join(dir, 'output') },
      async (_event, check, invoke) => { await invoke(); return check({ msgId: '9', msgElementId: '2', fileErrCode: '42', filePath: '/tmp/unrelated' }); }), { message: /fileErrCode/, code: '42' });
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true }); }
});

test('session abort after native completion prevents destination publication', async () => {
  const dir=await mkdtemp(join(tmpdir(),'qq-download-aborted-'));
  const abort=new AbortController();let requested=false;
  try {
    await assert.rejects(downloadAttachment({async downloadRichMedia(request:any){requested=true;await writeFile(request.filePath,'fixture');}},
      {chatType:2,peerUid:'123'},{messageId:'9',elementId:'2',destination:join(dir,'output')},
      async(_event,check,invoke)=>{await invoke();const staged=(await readdir(dir)).find(name=>name.startsWith('.qq-download-'))!;
        const file=check({msgId:'9',msgElementId:'2',fileErrCode:'0',fileSrvErrCode:'0',filePath:join(dir,staged,'attachment')});abort.abort();return file;},abort.signal),{name:'AbortError'});
    assert.equal(requested,true);assert.deepEqual(await readdir(dir),[],'staging is removed without publishing output');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('public capture rejects invalid inputs without getters/coercions and snapshots peer',()=>{
 const peer={type:'private',userId:'456'};const result=captureDownloadRequest(peer,'0009','02','/tmp/output');peer.userId='999';
 assert.deepEqual(result,{peer:{type:'private',userId:'456'},messageId:'0009',elementId:'02',destination:'/tmp/output'});
 let called=0;const getter={get type(){called++;return 'group'},groupId:'123'};
 assert.throws(()=>captureDownloadRequest(getter,'9','2','/tmp/output'));
 assert.throws(()=>captureDownloadRequest({type:'group',groupId:'123'}, {toString(){called++;return '9'}},'2','/tmp/output'));
 assert.throws(()=>captureDownloadRequest(Object.create({type:'group',groupId:'123'}),'9','2','/tmp/output'));
 for(const ids of [['bad','2'],['9','-1'],['9','']])assert.throws(()=>captureDownloadRequest({type:'group',groupId:'123'},ids[0],ids[1],'/tmp/output'));
 assert.throws(()=>captureDownloadRequest({type:'group',groupId:'123'},'9','2','/tmp/output\0tail'),/destination/);
 assert.equal(called,0);
});
test('native download captures peer before filesystem awaits and rejects malformed pre-FS input',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'qq-download-capture-'));let calls=0;
 try{
 const peer={chatType:2,peerUid:'123'},payload={messageId:'9',elementId:'2',destination:join(dir,'output')};
 const pending=downloadAttachment({async downloadRichMedia(r:any){calls++;assert.equal(r.chatType,2);assert.equal(r.peerUid,'123');assert.equal(r.msgId,'9');await writeFile(r.filePath,'captured');}},peer,payload,
 async(_e,check,invoke)=>{await invoke();const stage=(await readdir(dir)).find(n=>n.startsWith('.qq-download-'))!;return check({msgId:'9',msgElementId:'2',fileErrCode:0,fileSrvErrCode:0,filePath:join(dir,stage,'attachment')});});
 peer.chatType=1;peer.peerUid='other';payload.messageId='99';payload.destination=join(dir,'mutated');await pending;
 assert.equal(await readFile(join(dir,'output'),'utf8'),'captured');assert.equal(calls,1);
 for(const invalid of [{chatType:'2',peerUid:'123'},{chatType:2,peerUid:4}])await assert.rejects(downloadAttachment({downloadRichMedia(){calls++;}},invalid as any,{messageId:'9',elementId:'2',destination:join(dir,'never','output')},async()=>{}),/peer/);
 assert.deepEqual(await readdir(dir),['output']);assert.equal(calls,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('matching completion requires both explicit success codes and reported chat type matches',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'qq-download-fields-'));let getters=0;
 try{
 const base={msgId:'9',msgElementId:'2',fileErrCode:'0',fileSrvErrCode:'0',filePath:join(dir,'external')};await writeFile(base.filePath,'native cache');
 const invalid=[{...base,fileErrCode:undefined},{...base,fileSrvErrCode:undefined},{...base,fileErrCode:NaN},{...base,fileSrvErrCode:{}},{...base,fileErrCode:''},{...base,chatType:1},{...base,filePath:base.filePath+'\0private'},{...base,get fileErrCode(){getters++;return '0'}}];
 for(const complete of invalid)await assert.rejects(downloadAttachment({downloadRichMedia(){}},{chatType:2,peerUid:'123'},{messageId:'9',elementId:'2',destination:join(dir,'output')},async(_e,check,invoke)=>{invoke();return check(complete);}),{code:'invalid-result'});
 assert.equal(getters,0);assert.deepEqual(await readdir(dir),['external']);
 for(const code of ['42',42])await assert.rejects(downloadAttachment({downloadRichMedia(){}},{chatType:2,peerUid:'123'},{messageId:'9',elementId:'2',destination:join(dir,'output')},async(_e,check,invoke)=>{invoke();return check({...base,fileErrCode:code});}),{code});
 const result=await downloadAttachment({downloadRichMedia(){}},{chatType:2,peerUid:'123'},{messageId:'9',elementId:'2',destination:join(dir,'output')},async(_e,check,invoke)=>{invoke();assert.equal(check({...base,msgId:'other'}),undefined);return check(base);});
 assert.equal(await readFile(result.file,'utf8'),'native cache');assert.equal(await readFile(base.filePath,'utf8'),'native cache');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('payload wrapper rejects accessor fields without evaluating them',()=>{
 let calls=0;const payload={peer:{type:'group',groupId:'123'},get messageId(){calls++;return '9'},elementId:'2',destination:'/tmp/output'};
 assert.throws(()=>captureDownloadPayload(payload));assert.equal(calls,0);
 assert.deepEqual(captureDownloadPayload({peer:{type:'group',groupId:'123'},messageId:'9',elementId:'2',destination:'/tmp/output'}),{peer:{type:'group',groupId:'123'},messageId:'9',elementId:'2',destination:'/tmp/output'});
});
