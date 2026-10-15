import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Exercise the actual source or installed CLI entry while replacing only its
 * createClient acquisition boundary. No native addon, account or network is used.
 * @param {string} entry
 */
export async function verifyPrepareCli(entry) {
  const directory = await mkdtemp(join(tmpdir(), 'qq-prepare-cli-'));
  const canonicalEntry = await realpath(entry);
  const entryUrl = pathToFileURL(canonicalEntry).href;
  const config = join(directory, 'config.json');
  const events = join(directory, 'events.jsonl');
  const fixture = join(directory, 'client.mjs');
  const hook = join(directory, 'hook.mjs');
  try {
    await writeFile(
      config,
      JSON.stringify({
        dataDir: join(directory, 'data'),
        wrapperPath: join(directory, 'unused.node'),
        version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' },
        login: { method: 'quick', uin: '123' },
        autoLogin: true,
        autoReconnect: { maxAttempts: 2, delayMs: 1 },
      }),
    );
    await writeFile(
      fixture,
      `import {EventEmitter} from 'node:events';
import {appendFileSync} from 'node:fs';
const mode=process.env.QQ_PREPARE_FIXTURE;
function record(event, detail){appendFileSync(${JSON.stringify(events)},JSON.stringify({event,...detail})+'\\n');}
const output=console.log;
console.log=(line)=>{
  record('output');
  if(mode==='output-failure')throw Error('fixture output failed');
  output(line);
  if(mode==='signal-after')process.emit('SIGINT');
};
export async function createClient(options){
  record('create',{autoLogin:options.autoLogin,autoReconnect:options.autoReconnect,configuredLogin:options.login!==undefined});
  if(options.autoLogin!==false||options.autoReconnect!==false||options.login!==undefined)throw Error('prepare retained account configuration');
  if(mode==='create-failure')throw Error('fixture create failed');
  if(mode==='signal-before'||mode==='signal-reject'){
    process.emit('SIGINT');
    await new Promise(resolve=>setImmediate(resolve));
    if(mode==='signal-reject')throw Error('fixture late create failed');
  }
  record('initialized');
  return Object.assign(new EventEmitter(),{
    state:'idle',nativeExports:['Session','Engine'],
    async login(){record('login');throw Error('prepare attempted login');},
    async close(){record('close');await new Promise(resolve=>setImmediate(resolve));if(mode==='close-failure')throw Error('fixture close failed');},
  });
}
`,
    );
    await writeFile(
      hook,
      `import {registerHooks} from 'node:module';
process.dlopen=()=>{throw Error('native loading forbidden in CLI fixture');};
globalThis.fetch=async()=>{throw Error('network forbidden in CLI fixture');};
registerHooks({resolve(specifier,context,next){
  if(context.parentURL===${JSON.stringify(entryUrl)}&&(specifier==='./index.ts'||specifier==='./index.js'))return {url:${JSON.stringify(pathToFileURL(fixture).href)},shortCircuit:true};
  return next(specifier,context);
}});
`,
    );
    /** @type {Array<[string, number, string[], boolean, string | undefined]>} */
    const scenarios = [
      ['success', 0, ['create', 'initialized', 'output', 'close'], true, undefined],
      ['create-failure', 1, ['create'], false, 'fixture create failed'],
      [
        'output-failure',
        1,
        ['create', 'initialized', 'output', 'close'],
        false,
        'fixture output failed',
      ],
      [
        'close-failure',
        1,
        ['create', 'initialized', 'output', 'close'],
        true,
        'fixture close failed',
      ],
      ['signal-before', 130, ['create', 'initialized', 'close'], false, undefined],
      ['signal-after', 130, ['create', 'initialized', 'output', 'close'], true, undefined],
      ['signal-reject', 130, ['create'], false, 'fixture late create failed'],
    ];
    for (const [mode, status, expectedEvents, hasOutput, error] of scenarios) {
      await writeFile(events, '');
      const result = spawnSync(
        process.execPath,
        [
          '--unhandled-rejections=strict',
          '--import',
          pathToFileURL(hook).href,
          canonicalEntry,
          'prepare',
          '--config',
          config,
        ],
        { encoding: 'utf8', timeout: 10_000, env: { ...process.env, QQ_PREPARE_FIXTURE: mode } },
      );
      assert.equal(result.error, undefined, mode);
      assert.equal(result.status, status, `${mode}: ${result.stderr}`);
      const rows = (await readFile(events, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        rows.map((row) => row.event),
        expectedEvents,
        mode,
      );
      assert.deepEqual(
        rows[0],
        { event: 'create', autoLogin: false, autoReconnect: false, configuredLogin: false },
        mode,
      );
      if (hasOutput)
        assert.deepEqual(JSON.parse(result.stdout), {
          state: 'idle',
          nativeExports: ['Session', 'Engine'],
          nativeExportCount: 2,
        });
      else assert.equal(result.stdout, '', mode);
      if (typeof error === 'string') assert.equal(result.stderr.trim(), error, mode);
      else assert.equal(result.stderr, '', mode);
    }
    for (const flag of ['uin', 'method', 'qr-file']) {
      await writeFile(events, '');
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(hook).href,
          canonicalEntry,
          'prepare',
          '--config',
          join(directory, 'missing-config.json'),
          `--${flag}`,
          'unused',
        ],
        { encoding: 'utf8', timeout: 10_000 },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.equal(result.stderr.trim(), `Unknown option for prepare: --${flag}`);
      assert.equal(result.stdout, '');
      assert.equal(await readFile(events, 'utf8'), '');
    }
    return { cliPrepareLifecycleContract: true, cliPrepareLoginSuppressionContract: true };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
