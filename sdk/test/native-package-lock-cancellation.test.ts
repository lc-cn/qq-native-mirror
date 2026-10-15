import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquirePackageLock } from '../src/storage/native-package-lock.ts';

test('pre-cancelled package lock neither publishes nor removes an existing owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-package-lock-abort-'));
  const target = join(root, 'package');
  const controller = new AbortController();
  const reason = new Error('cancelled before acquisition');
  controller.abort(reason);
  try {
    await assert.rejects(acquirePackageLock(target, controller.signal), (e) => e === reason);
    assert.deepEqual(await readdir(root), []);
    const owner = `${process.pid}-existing-owner`;
    await writeFile(`${target}.lock`, owner);
    await assert.rejects(acquirePackageLock(target, controller.signal), (e) => e === reason);
    assert.equal(await readFile(`${target}.lock`, 'utf8'), owner);
    assert.deepEqual(await readdir(root), ['package.lock']);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelling a package lock waiter retains the holder and a later caller can acquire', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-package-lock-wait-'));
  const target = join(root, 'package');
  const controller = new AbortController();
  const reason = new Error('cancelled while another owner holds the lock');
  const release = await acquirePackageLock(target);
  try {
    const owner = await readFile(`${target}.lock`, 'utf8');
    const waiting = acquirePackageLock(target, controller.signal);
    const rejected = assert.rejects(waiting, (error) => error === reason);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    controller.abort(reason);
    await rejected;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(await readFile(`${target}.lock`, 'utf8'), owner);
    assert.deepEqual(await readdir(root), ['package.lock']);
    await release();
    const releaseNext = await acquirePackageLock(target);
    assert.notEqual(await readFile(`${target}.lock`, 'utf8'), owner);
    await releaseNext();
    assert.deepEqual(await readdir(root), []);
  } finally {
    await release();
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation after a dead-owner claim cleans only the claim and leaves the lock untouched', () => {
  const entry = new URL('../src/storage/native-package-lock.ts', import.meta.url).href;
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import fs from 'node:fs';import fsp from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-claim-cancel-')),target=path.join(root,'package'),owner='999999999-existing-owner';
const controller=new AbortController(),reason={cancelled:'after claim'},mkdir=fsp.mkdir,kill=process.kill;
fs.writeFileSync(target+'.lock',owner);
fsp.mkdir=async (...args)=>{const result=await mkdir(...args);controller.abort(reason);return result;};
process.kill=()=>{throw Object.assign(new Error('dead'),{code:'ESRCH'});};syncBuiltinESMExports();
try{const {acquirePackageLock}=await import(${JSON.stringify(entry)});let rejected=false;
try{await acquirePackageLock(target,controller.signal);}catch(error){rejected=error===reason;}
console.log(JSON.stringify({rejected,owner:fs.readFileSync(target+'.lock','utf8'),entries:fs.readdirSync(root)}));
}finally{fsp.mkdir=mkdir;process.kill=kill;syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});}
`,
      ],
      { encoding: 'utf8', timeout: 5000 },
    ),
  ) as { rejected: boolean; owner: string; entries: string[] };
  assert.equal(result.rejected, true);
  assert.equal(result.owner, '999999999-existing-owner');
  assert.deepEqual(result.entries, ['package.lock']);
});
