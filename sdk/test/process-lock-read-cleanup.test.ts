import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const modulePath = fileURLToPath(new URL('../src/storage/process-lock.ts', import.meta.url));
function probe(mode: string) {
  const script = `
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-lock-read-'));const target=path.join(dir,'lock');const token=process.pid+'-00000000-0000-0000-0000-000000000000';fs.writeFileSync(target,token);
const saved={readSync:fs.readSync,closeSync:fs.closeSync,lstatSync:fs.lstatSync,unlinkSync:fs.unlinkSync};
const mode=${JSON.stringify(mode)},primary=mode.includes('null')?null:mode.includes('undefined')?undefined:{opaque:'read'},cleanup={opaque:'close'};let armed=false,closes=0,codeReads=0;
if(mode==='stat-code-accessor')Object.defineProperty(primary,'code',{get(){codeReads++;throw cleanup;}});
fs.readSync=(...args)=>{if(armed&&mode==='dual')throw primary;return saved.readSync(...args)};
fs.closeSync=fd=>{saved.closeSync(fd);if(armed){closes++;if(mode==='dual'||mode==='close-only')throw cleanup;}};
fs.lstatSync=name=>{if(armed&&mode.startsWith('stat-'))throw primary;return saved.lstatSync(name)};
fs.unlinkSync=name=>{if(armed&&mode.startsWith('unlink-'))throw primary;return saved.unlinkSync(name)};
syncBuiltinESMExports();
try{const {readProcessLock,removeOwnedProcessLock}=await import(${JSON.stringify(modulePath)});armed=true;let caught,failed=false;
try{if(mode.startsWith('unlink-'))removeOwnedProcessLock(target,token);else readProcessLock(target)}catch(error){caught=error;failed=true;}
armed=false;const failures=caught instanceof AggregateError?caught.errors:[caught];process.stdout.write(JSON.stringify({failed,primaryIdentity:failures.includes(primary),cleanupIdentity:failures.includes(cleanup),failureCount:failures.length,closes,codeReads,lockIntact:fs.readFileSync(target,'utf8')===token}));
}finally{Object.assign(fs,saved);syncBuiltinESMExports();fs.rmSync(dir,{recursive:true,force:true});}
`;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 5000,
    }),
  ) as {
    failed: boolean;
    primaryIdentity: boolean;
    cleanupIdentity: boolean;
    failureCount: number;
    closes: number;
    codeReads: number;
    lockIntact: boolean;
  };
}
test('read and close failures retain both arbitrary values after one close', () => {
  const result = probe('dual');
  assert.equal(result.primaryIdentity, true);
  assert.equal(result.cleanupIdentity, true);
  assert.equal(result.failureCount, 2);
  assert.equal(result.closes, 1);
  assert.equal(result.lockIntact, true);
});
test('a lone close failure retains identity with one close attempt', () => {
  const result = probe('close-only');
  assert.equal(result.cleanupIdentity, true);
  assert.equal(result.failureCount, 1);
  assert.equal(result.closes, 1);
});
test('undefined and null inspection failures do not turn into code-access TypeErrors', () => {
  for (const mode of ['stat-undefined', 'stat-null']) {
    const result = probe(mode);
    assert.equal(result.failed, true);
    assert.equal(result.primaryIdentity, true);
    assert.equal(result.lockIntact, true);
  }
});
test('undefined and null unlink failures preserve the original value and lock', () => {
  for (const mode of ['unlink-undefined', 'unlink-null']) {
    const result = probe(mode);
    assert.equal(result.failed, true);
    assert.equal(result.primaryIdentity, true);
    assert.equal(result.lockIntact, true);
    assert.equal(result.closes, 1);
  }
});

test('opaque failure code accessors are never executed for missing-file classification', () => {
  const result = probe('stat-code-accessor');
  assert.equal(result.primaryIdentity, true);
  assert.equal(result.cleanupIdentity, false);
  assert.equal(result.codeReads, 0);
});
