import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const pin = JSON.parse(await readFile(join(root,'native/video/ffmpeg-source.json'),'utf8'));
const positional=process.argv.slice(2).filter(v=>!v.startsWith('--'));
if(positional.length>1||process.argv.slice(2).some(v=>v.startsWith('--')&&v!=='--verify-signature'))throw Error('Usage: prepare-video-source.mjs [DIRECTORY] [--verify-signature]');
const directory = resolve(positional[0] ?? join(root,'.local/video-source-build'));
const sha = data => createHash('sha256').update(data).digest('hex');
await mkdir(directory,{recursive:true});
async function download(url,path,expected) {
  try { const b=await readFile(path);if(expected && sha(b)===expected)return; } catch {}
  const response=await fetch(url,{signal:AbortSignal.timeout(300_000)});
  if(!response.ok)throw Error('Video source unavailable');
  const data=Buffer.from(await response.arrayBuffer());
  if(data.length>64*1024*1024 || (expected && sha(data)!==expected))throw Error('Video source integrity mismatch');
  await writeFile(path,data);
}
const archive=join(directory,`ffmpeg-${pin.version}.tar.xz`);
await download(pin.url,archive,pin.sha256);
let pgpVerified=false;
if(process.argv.includes('--verify-signature')) {
  const signature=archive+'.asc',key=join(directory,'ffmpeg-release-key.asc'),keyring=join(directory,'gpg');
  await download(pin.signatureUrl,signature);await download(pin.keyUrl,key);await mkdir(keyring,{recursive:true,mode:0o700});
  execFileSync('gpg',['--homedir',keyring,'--batch','--import',key],{stdio:'pipe'});
  const status=execFileSync('gpg',['--homedir',keyring,'--batch','--status-fd','1','--verify',signature,archive],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const valid=status.split('\n').filter(l=>l.startsWith('[GNUPG:] VALIDSIG '));
  if(valid.length!==1||!valid[0].split(' ').includes(pin.keyFingerprint))throw Error('Unexpected FFmpeg signing key');
  pgpVerified=true;
}
// GNU tar treats a Windows drive colon in -f as a remote host; use a local filename.
execFileSync('tar',['-xf',basename(archive)],{cwd:directory,stdio:'inherit'});
const source=join(directory,`ffmpeg-${pin.version}`);
if(sha(await readFile(join(source,'configure')))!==pin.configureSha256)throw Error('Pinned configure does not match release source');
await writeFile(join(directory,'source-verification.json'),JSON.stringify({version:pin.version,commit:pin.commit,archiveSha256:pin.sha256,configureSha256:pin.configureSha256,pgpVerified,keyFingerprint:pgpVerified?pin.keyFingerprint:undefined},null,2)+'\n');
console.log(JSON.stringify({source,archiveSha256:pin.sha256,pgpVerified}));
