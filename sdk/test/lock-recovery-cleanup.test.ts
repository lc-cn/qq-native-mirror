import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

function probe(family: 'account' | 'package', mode: string) {
  const entry = new URL(
    `../src/storage/${family === 'account' ? 'data-directory' : 'native-package'}-lock.ts`,
    import.meta.url,
  ).href;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import fs from 'node:fs';import fsp from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const mode=${JSON.stringify(mode)}, family=${JSON.stringify(family)};
const primary={tag:'remove'}, cleanup={tag:'claim'}, exists=Object.assign(new Error('exists'),{code:'EEXIST'});
const module=await import(${JSON.stringify(entry)});
let removes=0,releases=0,claims=0;
fs.linkSync=()=>{throw mode==='undefined'?undefined:mode==='null'?null:exists;};
fs.openSync=()=>7;fs.writeFileSync=()=>{};fs.closeSync=()=>{};
fs.unlinkSync=p=>{if(!p.includes('.owner-')){removes++;throw primary;}};
fs.lstatSync=()=>({isSymbolicLink:()=>true});fs.readlinkSync=()=> '999999-00000000-0000-0000-0000-000000000000';
process.kill=()=>{throw Object.assign(new Error('dead'),{code:'ESRCH'});};
fs.mkdirSync=()=>{claims++;if(mode==='claim')throw exists;};fs.rmdirSync=()=>{releases++;throw cleanup;};
fsp.mkdir=async()=>{claims++;if(mode==='claim')throw primary;};fsp.rm=async()=>{releases++;throw cleanup;};
syncBuiltinESMExports();
let caught=false, original=false, both=false;
try{if(family==='account')module.lockDataDirectory('/fake');else await module.acquirePackageLock('/fake');}
catch(error){caught=true;original=mode==='undefined'?error===undefined:mode==='null'?error===null:error===primary;both=error instanceof AggregateError&&error.errors[0]===primary&&error.errors[1]===cleanup;}
console.log(JSON.stringify({caught,original,both,removes,releases,claims}));
`,
      ],
      { encoding: 'utf8', timeout: 5000 },
    ),
  ) as {
    caught: boolean;
    original: boolean;
    both: boolean;
    removes: number;
    releases: number;
    claims: number;
  };
}
for (const family of ['account', 'package'] as const) {
  test(`${family} recovery preserves removal and claim cleanup failures`, () => {
    const result = probe(family, 'cleanup');
    assert.equal(result.both, true);
    assert.equal(result.removes, 1);
    assert.equal(result.releases, 1);
  });
  test(`${family} failed claim acquisition never releases another owner's claim`, () => {
    const result = probe(family, 'claim');
    assert.equal(result.caught, true);
    assert.equal(result.removes, 0);
    assert.equal(result.releases, 0);
  });
  for (const mode of ['undefined', 'null'])
    test(`${family} publication preserves ${mode} failure`, () => {
      assert.equal(probe(family, mode).original, true);
    });
}
