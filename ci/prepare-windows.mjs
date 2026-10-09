import {readFile,mkdir,writeFile,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
if(process.platform!=='win32')throw new Error('Windows-only source preparation');
const source=JSON.parse(await readFile('ci/sources.json','utf8')).find(s=>s.platform==='win32'&&s.arch===process.arch);
if(!source?.installerUrl||!source.installerSha256)throw new Error('Missing pinned Windows installer');
await mkdir('out',{recursive:true});
let cached;try{cached=await readFile('out/vendor-installer.exe');}catch{}
const response=cached?null:await fetch(source.installerUrl,{signal:AbortSignal.timeout(600000)});if(response&&!response.ok)throw new Error('Installer download failed');
let size=0;const chunks=[];for await(const chunk of response?.body??[]){size+=chunk.length;if(size>512*1024*1024)throw new Error('Installer too large');chunks.push(Buffer.from(chunk));}
const body=cached??Buffer.concat(chunks);if(createHash('sha256').update(body).digest('hex')!==source.installerSha256)throw new Error('Installer checksum mismatch');
await writeFile('out/vendor-installer.exe',body);
execFileSync('7z',['x','-y',resolve('out/vendor-installer.exe'),`-o${resolve('out/extracted')}`],{stdio:'inherit'});
async function find(path){for(const name of await readdir(path)){const child=join(path,name);if((await stat(child)).isDirectory()){try{await stat(join(child,'resources/app/wrapper.node'));return child;}catch{}const match=await find(child);if(match)return match;}}}
const root=await find('out/extracted');if(!root)throw new Error('No native app root found');
execFileSync('python',['ci/windows/export-windows-native.py',root,'out/windows-source'],{stdio:'inherit'});
const manifest=JSON.parse(await readFile('out/windows-source/manifest.json','utf8'));
if(manifest.arch!==process.arch||['clientVersion','appId','qua'].some(k=>manifest.version[k]!==source.version[k]))throw new Error('Windows kernel metadata mismatch');
