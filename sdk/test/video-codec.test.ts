import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoElement } from '../src/media-send.ts';
import { videoThumbnail } from '../src/video-thumbnail.ts';
import { loadVideoCodec } from '../src/video-codec-loader.ts';
import { createNativeServices } from '../src/native-services.ts';

const png = () => { const b = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a','hex').copy(b); b.write('IHDR',12); b.writeUInt32BE(64,16); b.writeUInt32BE(64,20); return b; };
const jpeg = () => Buffer.from('ffd8ffe000040000ffc00008080040004003ffd9','hex');
const bmp = () => { const b = Buffer.alloc(54); b.write('BM'); b.writeUInt32LE(40,14); b.writeInt32LE(64,18); b.writeInt32LE(-64,22); b.writeUInt16LE(1,26); b.writeUInt16LE(24,28); return b; };
const metadata = () => ({width:64,height:64,duration:0.4,format:'png' as const,image:png()});
async function fixture(run: (file: string, destination: string, bytes: Buffer) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(),'qq-video-codec-'));
  const bytes = Buffer.alloc(24); bytes.writeUInt32BE(24); bytes.write('ftyp',4); bytes.write('isom',8);
  const file = join(dir,'source.mp4'); await writeFile(file,bytes);
  try { await run(file,join(dir,'cache','Ori','video.mp4'),bytes); } finally { await rm(dir,{recursive:true,force:true}); }
}
test('codec measures video and preserves JPG thumbnail format, source and native Map', () => fixture(async(file,destination,bytes)=> {
  const result = await createVideoElement(file,{getRichMediaFilePathForGuild:async()=>destination},{ffmpeg:'not-invoked',ffprobe:'not-invoked'},{getVideoInfo:async()=>({...metadata(),format:'jpg',image:jpeg()})});
  assert.equal(result.videoElement.fileTime,0.4); assert.equal(result.videoElement.thumbWidth,64);
  assert.ok(result.videoElement.thumbPath instanceof Map); assert.match(result.videoElement.thumbPath.get(0), /\.jpg$/);
  assert.deepEqual(await readFile(result.videoElement.thumbPath.get(0)),jpeg()); assert.deepEqual(await readFile(file),bytes); assert.deepEqual(await readFile(destination),bytes);
}));
test('thumbnail parser accepts PNG, JPEG and bottom-up or top-down BMP with valid encoded dimensions',()=>{
  assert.equal(videoThumbnail(png(),'png'),'png'); assert.equal(videoThumbnail(jpeg(),'jpeg'),'jpg'); assert.equal(videoThumbnail(bmp(),'bmp24'),'bmp');
  const bottomUp = bmp(); bottomUp.writeInt32LE(64,22); assert.equal(videoThumbnail(bottomUp,'bmp'),'bmp');
});
test('thumbnail parser rejects truncated markers, wrong dimensions, declarations and BMP depth',()=>{
  for(const [image,format] of [[Buffer.from('ffd8ffff','hex'),'jpg'],[Buffer.from('ffd8ffe00003','hex'),'jpg'],[png(),'jpg'],[jpeg(),'png'],[png(),'mp4'],[Buffer.alloc(54),'bmp']] as const) assert.throws(()=>videoThumbnail(image,format));
  const zero=png();zero.writeUInt32BE(0,16);assert.throws(()=>videoThumbnail(zero,'png'),/dimensions/);
  const wrongDepth=bmp();wrongDepth.writeUInt16LE(8,28);assert.throws(()=>videoThumbnail(wrongDepth,'bmp24'),/BMP/);
});
test('invalid codec metadata fails before staging and never invokes configured tools',()=>fixture(async(file)=>{
  let staged=0;
  for(const change of [{width:'64'}, {width:0}, {height:Infinity}, {duration:'0.4'}, {duration:NaN}, {duration:0}, {image:new Uint8Array(png())}, {image:Buffer.alloc(0)}, {format:'mp4'}]) {
    await assert.rejects(createVideoElement(file,{getRichMediaFilePathForGuild(){staged++;}},{ffmpeg:'missing',ffprobe:'missing'},{getVideoInfo:async()=>({...metadata(),...change} as any)}));
  }
  assert.equal(staged,0);
}));
test('codec exception propagates without CLI fallback or staging',()=>fixture(async(file)=>{
  let staged=0;await assert.rejects(createVideoElement(file,{getRichMediaFilePathForGuild(){staged++;}},{ffmpeg:'missing',ffprobe:'missing'},{getVideoInfo:async()=>{throw Error('codec failed');}}),/codec failed/);assert.equal(staged,0);
}));
test('codec input rejects fake MP4 before decoder and staging',()=>fixture(async(file)=>{
  await writeFile(file,'fake video');let decoded=0;await assert.rejects(createVideoElement(file,{},undefined,{getVideoInfo:async()=>{decoded++;return metadata();}}),/MP4 container/);assert.equal(decoded,0);
}));
test('thumbnail bytes are copied before an asynchronous native staging request',()=>fixture(async(file,destination)=>{
  const value=metadata();const expected=Buffer.from(value.image);
  const result=await createVideoElement(file,{getRichMediaFilePathForGuild:async()=>{value.image.fill(0);value.width=1;return destination;}},undefined,{getVideoInfo:async()=>value});
  assert.deepEqual(await readFile(result.videoElement.thumbPath.get(0)),expected);assert.equal(result.videoElement.thumbWidth,64);
}));
test('abort during a pending codec settles without staging even after late resolution',()=>fixture(async(file)=>{
  const stop=new AbortController();let resolve!:(value:any)=>void,started!:()=>void;const begin=new Promise<void>(r=>started=r);let staged=0;
  const promise=createVideoElement(file,{getRichMediaFilePathForGuild(){staged++;}},undefined,{getVideoInfo:()=>{started();return new Promise(r=>resolve=r);}},stop.signal);
  const result=assert.rejects(promise,/aborted/);await begin;stop.abort();await result;resolve(metadata());await new Promise(r=>setImmediate(r));assert.equal(staged,0);
}));
test('abort during pending staging skips cache file copy and thumbnail writes',()=>fixture(async(file,destination)=>{
  const stop=new AbortController();let resolve!:(value:string)=>void,started!:()=>void;const begin=new Promise<void>(r=>started=r);
  const promise=createVideoElement(file,{getRichMediaFilePathForGuild(){started();return new Promise(r=>resolve=r);}},undefined,{getVideoInfo:async()=>metadata()},stop.signal);
  const rejected=assert.rejects(promise,/aborted/);await begin;stop.abort();await rejected;resolve(destination);await new Promise(r=>setImmediate(r));await assert.rejects(readFile(destination),{code:'ENOENT'});
}));
test('video codec loader supports named/default JS and CJS and rejects invalid paths or exports',()=>fixture(async(file)=>{
  for(const [suffix,text] of [['.mjs','export const getVideoInfo=async()=>({});'],['-default.mjs','export default {getVideoInfo:async()=>({})};'],['.cjs','module.exports={getVideoInfo:async()=>({})};']]) {
    const module=file+suffix;await writeFile(module,text);assert.equal(typeof(await loadVideoCodec(module)).getVideoInfo,'function');
  }
  await assert.rejects(loadVideoCodec('relative.mjs'),/absolute/);
  const invalid=file+'-invalid.mjs';await writeFile(invalid,'export default {};');await assert.rejects(loadVideoCodec(invalid),/getVideoInfo/);
}));
test('native services passes its close signal to a pending video codec and never dispatches send',()=>fixture(async(file)=>{
  let started!:()=>void;const begin=new Promise<void>(r=>started=r);let dispatched=0;
  const msg={addKernelMsgListener(){},removeKernelMsgListener(){},getRichMediaFilePathForGuild(){dispatched++;},sendMsg(){dispatched++;}};
  const native=createNativeServices({getMsgService:()=>msg,getBuddyService:()=>({addKernelBuddyListener(){},removeKernelBuddyListener(){}}),getGroupService:()=>({addKernelGroupListener(){},removeKernelGroupListener(){}})},'version',()=>{},undefined,undefined,undefined,undefined,undefined,{getVideoInfo:()=>{started();return new Promise(()=>{});}});
  try {
    const promise=native.invokeOperation('sendGroupMessage',{groupId:'123',message:[{type:'video',file}]});const rejected=assert.rejects(promise,/abort|closed/i);await begin;native.close();await rejected;assert.equal(dispatched,0);
  } finally {native.close();}
}));

test('downsampled thumbnail is accepted while native dimensions retain measured video width and height',()=>fixture(async(file,destination)=>{
  const result=await createVideoElement(file,{getRichMediaFilePathForGuild:async()=>destination},undefined,{getVideoInfo:async()=>({...metadata(),width:1280,height:720})});
  assert.equal(result.videoElement.thumbWidth,1280);assert.equal(result.videoElement.thumbHeight,720);assert.deepEqual(await readFile(result.videoElement.thumbPath.get(0)),png());assert.equal('videoWidth' in result.videoElement,false);
}));
