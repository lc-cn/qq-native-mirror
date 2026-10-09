import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadAttachment } from '../src/media-operations.ts';

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
        const file=check({msgId:'9',msgElementId:'2',fileErrCode:'0',filePath:join(dir,staged,'attachment')});abort.abort();return file;},abort.signal),{name:'AbortError'});
    assert.equal(requested,true);assert.deepEqual(await readdir(dir),[],'staging is removed without publishing output');
  } finally {await rm(dir,{recursive:true,force:true});}
});
