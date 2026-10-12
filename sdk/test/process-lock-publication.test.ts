import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const modulePath = fileURLToPath(new URL('../src/storage/process-lock.ts', import.meta.url));
function probe(mode: string) {
  const script = `
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-publication-'));
const target=path.join(dir,'lock');const token=process.pid+'-00000000-0000-0000-0000-000000000000';const other=process.pid+'-11111111-1111-1111-1111-111111111111';
const original={linkSync:fs.linkSync,unlinkSync:fs.unlinkSync,closeSync:fs.closeSync,writeFileSync:fs.writeFileSync};
const primary=undefined,cleanup={opaque:'temporary'},closing={opaque:'close'},rollback={opaque:'rollback'};let closeCalls=0,unlinkCalls=0,armed=false;
const mode=${JSON.stringify(mode)};
if(mode==='existing') original.writeFileSync(target,other);
fs.closeSync=fd=>{if(armed)closeCalls++;original.closeSync(fd);if(armed&&(mode==='close'||mode==='write-close'))throw closing;};
fs.writeFileSync=(...args)=>{if(armed&&mode==='write-close')throw primary;return original.writeFileSync(...args);};
fs.linkSync=(from,to)=>{if(mode==='primary')throw primary;return original.linkSync(from,to);};
fs.unlinkSync=name=>{unlinkCalls++;if(name.includes('.owner-')){
 if(mode==='replacement'){original.unlinkSync(target);original.writeFileSync(target,other);}
 if(mode!=='close'&&mode!=='success')throw cleanup;
}if(name===target&&mode==='rollback')throw rollback;return original.unlinkSync(name);};
syncBuiltinESMExports();
try{const {publishProcessLock,readProcessLock}=await import(${JSON.stringify(modulePath)});let outcome;armed=true;
try{publishProcessLock(target,token);outcome={ok:true};}catch(error){const errors=error instanceof AggregateError?error.errors:[error];outcome={ok:false,primary:errors.includes(primary),cleanup:errors.includes(cleanup),closing:errors.includes(closing),rollback:errors.includes(rollback),count:errors.length,code:errors[0]?.code};}
armed=false;const exists=fs.existsSync(target);process.stdout.write(JSON.stringify({outcome,exists,owner:exists?readProcessLock(target):null,own:exists&&readProcessLock(target)===token,other:exists&&readProcessLock(target)===other,closeCalls,unlinkCalls}));
}finally{Object.assign(fs,original);syncBuiltinESMExports();fs.rmSync(dir,{recursive:true,force:true});}
`;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 5000,
    }),
  ) as {
    outcome: {
      ok: boolean;
      primary?: boolean;
      cleanup?: boolean;
      closing?: boolean;
      rollback?: boolean;
      count?: number;
      code?: string;
    };
    exists: boolean;
    own: boolean;
    other: boolean;
    closeCalls: number;
  };
}
test('successful synchronous publication keeps the owned lock after one close', () => {
  const result = probe('success');
  assert.equal(result.outcome.ok, true);
  assert.equal(result.own, true);
  assert.equal(result.closeCalls, 1);
});
test('failed temporary cleanup rolls back a successfully published owned lock', () => {
  const result = probe('temporary');
  assert.equal(result.outcome.cleanup, true);
  assert.equal(result.outcome.count, 1);
  assert.equal(result.exists, false);
});
test('publication preserves undefined primary and independent cleanup failures', () => {
  const result = probe('primary');
  assert.equal(result.outcome.primary, true);
  assert.equal(result.outcome.cleanup, true);
  assert.equal(result.outcome.count, 2);
  assert.equal(result.exists, false);
});
test('cleanup failure never removes an existing or replacement owner', () => {
  const existing = probe('existing');
  assert.equal(existing.outcome.code, 'EEXIST');
  assert.equal(existing.outcome.cleanup, true);
  assert.equal(existing.other, true);
  const replacement = probe('replacement');
  assert.equal(replacement.outcome.cleanup, true);
  assert.equal(replacement.other, true);
});
test('rollback failure retains cleanup identity and close failure is never retried', () => {
  const rollback = probe('rollback');
  assert.equal(rollback.outcome.cleanup, true);
  assert.equal(rollback.outcome.rollback, true);
  assert.equal(rollback.outcome.count, 2);
  const closed = probe('close');
  assert.equal(closed.outcome.closing, true);
  assert.equal(closed.closeCalls, 1);
  assert.equal(closed.exists, false);
});

test('write close and temporary removal each retain their independent failure once', () => {
  const result = probe('write-close');
  assert.equal(result.outcome.primary, true);
  assert.equal(result.outcome.closing, true);
  assert.equal(result.outcome.cleanup, true);
  assert.equal(result.outcome.count, 3);
  assert.equal(result.closeCalls, 1);
  assert.equal(result.exists, false);
});
