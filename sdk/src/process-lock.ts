import {randomUUID} from 'node:crypto';
import {constants,openSync,writeFileSync,closeSync,linkSync,unlinkSync,lstatSync,readlinkSync,fstatSync,readSync} from 'node:fs';

const maxOwnerBytes = 128;
/** Publish only a fully written owner file. Hardlinks require same-volume filesystem support. */
export function publishProcessLock(path: string, owner: string): void {
 const temporary = `${path}.owner-${randomUUID()}`;
 let fd: number | undefined;
 let created = false;
 try {
  fd = openSync(temporary,'wx',0o600); created = true;
  writeFileSync(fd,owner,'utf8'); closeSync(fd); fd = undefined;
  linkSync(temporary,path);
 } finally {
  try {if(fd !== undefined) closeSync(fd);}
  finally {if(created) unlinkSync(temporary);}
 }
}
/** Legacy links are read as tokens, never followed. Regular files are bounded and identity checked. */
export function readProcessLock(path: string): string | undefined {
 try {
  const stat = lstatSync(path);
  let owner: string;
  if(stat.isSymbolicLink()) owner = readlinkSync(path);
  else {
   if(!stat.isFile() || stat.size < 1 || stat.size > maxOwnerBytes) throw new Error('Invalid process lock file');
   const fd = openSync(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
   try {
    const actual = fstatSync(fd);
    if(!actual.isFile() || actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size !== stat.size) throw new Error('Process lock changed while reading');
    const bytes = Buffer.alloc(maxOwnerBytes+1);
    const length = readSync(fd,bytes,0,bytes.length,0);
    if(length !== stat.size || length > maxOwnerBytes) throw new Error('Invalid process lock file');
    owner = bytes.subarray(0,length).toString('utf8');
   } finally {closeSync(fd);}
  }
  if(owner.length > maxOwnerBytes || !/^[1-9]\d{0,15}-[a-zA-Z0-9-]{1,80}$/.test(owner) || !Number.isSafeInteger(Number(owner.split('-')[0]))) throw new Error('Invalid process lock owner');
  return owner;
 } catch(error) {if((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
}
export function removeOwnedProcessLock(path: string, owner: string): void {
 if(readProcessLock(path) === owner) {
  try {unlinkSync(path);} catch(error) {if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
 }
}
