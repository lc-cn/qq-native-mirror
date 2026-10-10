// Static source/shape audit only: no adapter, native module or account is run.
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const commit = '26d7533e0f5800fdff865ab2f2ad7692917e1076';
const sources = [
  { family: 'Global', name: 'NodeIGlobalAdapter', sha: '4df9b66e122c13f6db9e0986d750ee5c92d7e275' },
  {
    family: 'Depends',
    name: 'NodeIDependsAdapter',
    sha: '493f6e7336e050ab90c236f1564015ad355e459d',
  },
  {
    family: 'Dispatcher',
    name: 'NodeIDispatcherAdapter',
    sha: 'fb9d24bd8103fbb15dfef30c63e73ae6d33da90b',
  },
];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => {
  if (!condition) throw Error(message);
};
// Conservative lexical boundary scanner, not a general TypeScript parser.
// Reject unknown source shapes rather than infer an implementation contract.
function structural(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      check(end >= 0, 'Unterminated comment');
      out += ' '.repeat(end + 2 - i);
      i = end + 2;
      continue;
    }
    if ('\'"`'.includes(text[i])) {
      const quote = text[i],
        start = i++;
      let done = false;
      for (; i < text.length; i++) {
        if (text[i] === '\\') {
          i++;
          continue;
        }
        if (text[i] === quote) {
          i++;
          done = true;
          break;
        }
      }
      check(done, 'Unterminated string');
      out += ' '.repeat(i - start);
      continue;
    }
    out += text[i++];
  }
  return out;
}
function endOf(mask, start) {
  const pairs = { '(': ')', '[': ']', '{': '}' },
    stack = [pairs[mask[start]]];
  check(stack[0], 'Invalid balanced boundary');
  for (let i = start + 1; i < mask.length; i++) {
    const char = mask[i];
    if (pairs[char]) stack.push(pairs[char]);
    else if (')]}'.includes(char)) {
      check(stack.pop() === char, 'Mismatched source boundary');
      if (!stack.length) return i;
    }
  }
  throw Error('Unterminated source boundary');
}
function parts(text) {
  const mask = structural(text),
    result = [];
  let start = 0;
  for (let i = 0; i < mask.length; i++) {
    if ('([{'.includes(mask[i])) {
      i = endOf(mask, i);
      continue;
    }
    if (mask[i] === ',') {
      result.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  result.push(text.slice(start).trim());
  return result.filter(Boolean);
}
const literal = (text) => {
  check(/^['"][A-Za-z_$][A-Za-z0-9_$-]*['"]$/.test(text), 'Nonliteral callback name/family');
  return text.slice(1, -1);
};
function sdkCallbacks(text) {
  const entries = new Map(),
    mask = structural(text);
  for (const match of mask.matchAll(/\bcallbacks\s*\(/g)) {
    const start = match.index + match[0].lastIndexOf('('),
      end = endOf(mask, start),
      args = parts(text.slice(start + 1, end));
    if (args.length < 3 || !/^['"]/.test(args[2])) continue;
    const family = literal(args[2]);
    if (!sources.some((source) => source.family === family)) continue;
    check(!entries.has(family), 'Duplicate SDK callback family');
    check(args[0].startsWith('[') && args[0].endsWith(']'), 'Nonliteral SDK callback list');
    const methods = new Map(
      parts(args[0].slice(1, -1)).map((name) => [literal(name), 'audited-noop']),
    );
    check(args[1].startsWith('{') && args[1].endsWith('}'), 'Nonliteral SDK callback overrides');
    for (const property of parts(args[1].slice(1, -1))) {
      const name = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(property)?.[1];
      check(name, 'Unknown SDK callback property');
      methods.set(name, 'handled');
    }
    entries.set(family, methods);
  }
  for (const source of sources) check(entries.has(source.family), 'SDK callback family missing');
  return entries;
}
function upstreamMethods(text, name) {
  const mask = structural(text),
    header = new RegExp('export\\s+class\\s+' + name + '\\s*\\{').exec(mask);
  check(header, 'Expected adapter class');
  const start = header.index + header[0].lastIndexOf('{'),
    end = endOf(mask, start);
  check(!mask.slice(end + 1).trim(), 'Unexpected extra source');
  const methods = [];
  let cursor = start + 1;
  while (cursor < end) {
    while (/\s/.test(mask[cursor] ?? '')) cursor++;
    if (cursor === end) break;
    const method = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(mask.slice(cursor));
    check(method, 'Unsupported upstream member');
    const argsStart = cursor + method[0].lastIndexOf('('),
      argsEnd = endOf(mask, argsStart);
    cursor = argsEnd + 1;
    while (/\s/.test(mask[cursor] ?? '')) cursor++;
    check(mask[cursor] === '{', 'Unexpected upstream return/body shape');
    const bodyEnd = endOf(mask, cursor);
    methods.push({
      name: method[1],
      upstreamBody: mask.slice(cursor + 1, bodyEnd).trim() ? 'implemented' : 'empty',
    });
    cursor = bodyEnd + 1;
  }
  return methods;
}
try {
  check(
    process.argv.length === 3 || process.argv.length === 4,
    'Usage: node scripts/audit-host-adapters.mjs PINNED_SOURCE_DIRECTORY [SHAPE_AUDIT_RECEIPT]',
  );
  const directory = resolve(process.argv[2]);
  const kernelBytes = await readFile(join(root, 'src/kernel.ts'));
  const sdk = sdkCallbacks(kernelBytes.toString('utf8'));
  const adapters = [];
  for (const source of sources) {
    const bytes = await readFile(join(directory, source.name + '.ts'));
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    check(blob === source.sha, `Pinned source blob mismatch: ${source.name}`);
    const methods = upstreamMethods(bytes.toString('utf8'), source.name).map((method) => ({
      ...method,
      sdkHandling: sdk.get(source.family).get(method.name) ?? 'fallback-audited-noop',
    }));
    adapters.push({
      family: source.family,
      gitBlobSha1: blob,
      size: bytes.length,
      source: `https://github.com/NapNeko/NapCatQQ/blob/${commit}/packages/napcat-core/adapters/${source.name}.ts`,
      methods,
    });
  }
  const observed = [];
  if (process.argv[3]) {
    // Read only callback shape fields. Never copy other receipt/account fields.
    const bytes = await readFile(resolve(process.argv[3]));
    check(bytes.length <= 1024 * 1024, 'Audit receipt too large');
    const receipt = JSON.parse(bytes);
    const values = receipt.callbackAudit ?? receipt.nativeCallbackAudit;
    check(Array.isArray(values) && values.length <= 128, 'Missing or invalid shape audit');
    const types = new Set([
      'null',
      'array',
      'undefined',
      'boolean',
      'number',
      'bigint',
      'string',
      'symbol',
      'function',
      'object',
    ]);
    for (const value of values) {
      check(
        value &&
          typeof value === 'object' &&
          typeof value.family === 'string' &&
          /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.family) &&
          typeof value.name === 'string' &&
          /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(value.name) &&
          Array.isArray(value.argumentTypes) &&
          value.argumentTypes.length <= 64 &&
          value.argumentTypes.every((type) => types.has(type)) &&
          Number.isSafeInteger(value.count) &&
          value.count > 0,
        'Invalid callback audit shape',
      );
      if (!sdk.has(value.family)) continue;
      const adapter = adapters.find((item) => item.family === value.family);
      observed.push({
        family: value.family,
        name: value.name,
        argumentTypes: [...value.argumentTypes],
        count: value.count,
        declaredByPinnedUpstream: adapter.methods.some((method) => method.name === value.name),
        sdkHandling: sdk.get(value.family).get(value.name) ?? 'fallback-audited-noop',
        meaning: 'unclassified-host-contract',
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        upstreamCommit: commit,
        kernelSourceSha256: sha(kernelBytes),
        adapters,
        observed,
        nativeExecuted: false,
        accountUsed: false,
        limits: [
          'Empty upstream methods establish source similarity only; their requiredness and signing role remain unproven.',
          'Callback shapes cannot reveal arguments, return contracts, native signing results or server account markers.',
          'Absence from a bounded audit is not absence from a native execution path.',
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Host adapter audit failed');
  process.exitCode = 1;
}
