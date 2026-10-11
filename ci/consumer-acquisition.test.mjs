import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { closeConsumerResources } from './consumer-resources.mjs';

const require = createRequire(new URL('../sdk/package.json', import.meta.url));
/** @type {typeof import('../sdk/node_modules/typescript/lib/typescript.js')} */
const ts = require('typescript');

// Exercise only the actual acquisition prefix and its catch/finally. Imports,
// registry creation, installation and native preparation never enter this probe.
function acquisitionProgram() {
  const source = readFileSync(new URL('./verify-consumer.mjs', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('verify-consumer.mjs', source, ts.ScriptTarget.Latest, true);
  const transactions = parsed.statements.filter(ts.isTryStatement);
  assert.equal(transactions.length, 1);
  const transaction = transactions[0];
  assert.ok(transaction?.catchClause && transaction.finallyBlock);
  const stop = transaction.tryBlock.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) && declaration.name.text === 'deviceNames',
      ),
  );
  assert.ok(stop, 'The controlled prefix must end before registry acquisition');
  const declarations = parsed.statements
    .filter((statement) => statement.end <= transaction.pos && !ts.isImportDeclaration(statement))
    .map((statement) => statement.getText(parsed))
    .join('\n');
  const prefix = source.slice(transaction.tryBlock.getStart(parsed) + 1, stop.getStart(parsed));
  assert.ok(!/\bimport\s*\(|\bcreateClient\s*\(|\bcreateServer\s*\(/.test(prefix));
  return `${declarations}\ntry {${prefix}} ${transaction.catchClause.getText(parsed)} finally ${transaction.finallyBlock.getText(parsed)}`;
}

/** @param {string} program @param {'canonicalization'|'metadata'|'main'|'auxiliary'|'pack'|'codec'} stage @param {boolean} [preservesPrimary] */
async function probe(program, stage, preservesPrimary = true) {
  const parent = await mkdtemp(join(tmpdir(), 'qq-ci-acquisition-test-'));
  const primary = new Error(`${stage} failed`);
  /** @type {string|undefined} */
  let acquired;
  let removed = 0;
  let reads = 0;
  let packs = 0;
  const stages = ['metadata', 'main', 'auxiliary', 'codec'];
  const ports = {
    mkdtemp: async () => (acquired = await mkdtemp(join(parent, 'owned-'))),
    realpath: async (/** @type {string} */ path) => {
      if (stage === 'canonicalization') throw primary;
      return realpath(path);
    },
    readFile: async () => {
      const current = stages[reads++];
      if (current === stage) throw primary;
      return current === 'metadata' ? '{"version":"0.0.2"}' : Buffer.from('controlled archive');
    },
    execFileSync: () => {
      packs++;
      if (stage === 'pack') throw primary;
    },
    execFile: () => assert.fail('No child process may execute'),
    promisify: () => () => assert.fail('No child process may execute'),
    npm: ['controlled-npm', []],
    process: { platform: 'linux', arch: 'x64' },
    tmpdir,
    join,
    resolve,
    createHash,
    closeConsumerResources,
    rm: async (/** @type {string} */ path, /** @type {Parameters<typeof rm>[1]} */ options) => {
      assert.equal(path, acquired, 'Release the original acquisition path even if realpath fails');
      removed++;
      await rm(path, options);
    },
  };
  try {
    const execute = new Function(
      'ports',
      `'use strict'; const {mkdtemp, realpath, readFile, execFileSync, execFile, promisify, npm, process, tmpdir, join, resolve, createHash, closeConsumerResources, rm} = ports; return (async () => {${program}})();`,
    );
    if (preservesPrimary) await assert.rejects(execute(ports), (error) => error === primary);
    else await assert.doesNotReject(execute(ports));
    assert.ok(acquired);
    const directoryExists = await access(acquired).then(
      () => true,
      (/** @type {unknown} */ error) => {
        assert.ok(error instanceof Error && 'code' in error && error.code === 'ENOENT');
        return false;
      },
    );
    return { removed, directoryExists, reads, packs };
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

await test('actual CI acquisition failure releases its directory before any registry or native use', async () => {
  const program = acquisitionProgram();
  for (const stage of /** @type {const} */ ([
    'canonicalization',
    'metadata',
    'main',
    'auxiliary',
    'pack',
    'codec',
  ])) {
    const result = await probe(program, stage);
    assert.equal(result.removed, 1);
    assert.equal(result.directoryExists, false);
    assert.equal(result.packs, ['pack', 'codec'].includes(stage) ? 1 : 0);
  }
});

await test('removing actual acquisition cleanup reproduces the leaked-directory regression', async () => {
  const program = acquisitionProgram();
  const end = program.lastIndexOf(' finally ');
  assert.ok(end > 0);
  // This mutation also swallows the primary: the cleanup owner normally rethrows it.
  const result = await probe(`${program.slice(0, end)} finally {}`, 'metadata', false);
  assert.equal(result.removed, 0);
  assert.equal(result.directoryExists, true);
});
