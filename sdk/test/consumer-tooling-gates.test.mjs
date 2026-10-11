import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { ESLint } from 'eslint';
import { collectConsumerModuleReferences } from '../scripts/consumer-module-references.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helper = resolve(root, 'scripts/consumers/face-consumer-contract.mjs');
const source = readFileSync(helper, 'utf8');

test('group-query owner consumer rejects an invalid port and an unobserved assertion without execution', async () => {
  const queryHelper = resolve(root, 'scripts/consumers/group-query-owner-consumer-contract.mjs');
  const querySource = readFileSync(queryHelper, 'utf8');
  assert.deepEqual(diagnostics(querySource, queryHelper), []);
  const invalid = replaceOnce(querySource, 'getAllMemberList: request', 'getAllMemberList: 42');
  assert.ok(diagnostics(invalid, queryHelper).length > 0);
  const floating = replaceOnce(
    querySource,
    'await assert.rejects(preflight[method](id)',
    'assert.rejects(preflight[method](id)',
  );
  const reports = await new ESLint({
    cwd: root,
    // In-memory negative fixtures need a persistent program in CI too. Single-run
    // inference can reuse the earlier compiler parse and lose imported types.
    overrideConfig: {
      languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } },
    },
  }).lintText(floating, { filePath: queryHelper });
  assert.ok(
    reports
      .flatMap((report) => report.messages)
      .some((message) => message.ruleId === '@typescript-eslint/no-floating-promises'),
  );
});
function replaceOnce(value, before, after) {
  assert.equal(value.split(before).length - 1, 1, `Fixture anchor must occur once: ${before}`);
  return value.replace(before, after);
}

test('request-result consumer retains typed ports and awaited assertions without execution', async () => {
  const file = resolve(root, 'scripts/consumers/request-result-consumer-contract.mjs');
  const actual = readFileSync(file, 'utf8');
  assert.deepEqual(diagnostics(actual, file), []);
  assert.ok(
    diagnostics(
      replaceOnce(
        actual,
        '          approvalFriendRequest() {\n            calls++;\n            return result;\n          },',
        '          approvalFriendRequest: 42,',
      ),
      file,
    ).length > 0,
  );
  const eslint = new ESLint({
    cwd: root,
    overrideConfig: {
      languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } },
    },
  });
  const good = await eslint.lintText(actual, { filePath: file });
  assert.equal(good[0].errorCount, 0);
  const floating = replaceOnce(
    actual,
    '        await assert.rejects(\n          operations.invokeOperation(method, {\n            request: { uid:',
    '        assert.rejects(\n          operations.invokeOperation(method, {\n            request: { uid:',
  );
  const reports = await eslint.lintText(floating, { filePath: file });
  assert.ok(
    reports
      .flatMap((report) => report.messages)
      .some((message) => message.ruleId === '@typescript-eslint/no-floating-promises'),
  );
});

test('contact/group snapshot consumer rejects an invalid native port and unobserved mutation without execution', async () => {
  const file = resolve(root, 'scripts/consumers/contact-group-snapshot-consumer-contract.mjs');
  const actual = readFileSync(file, 'utf8');
  assert.deepEqual(diagnostics(actual, file), []);
  assert.ok(
    diagnostics(
      replaceOnce(actual, 'getBuddyService: () => buddy,', 'getBuddyService: () => 42,'),
      file,
    ).length > 0,
  );
  const eslint = new ESLint({
    cwd: root,
    overrideConfig: {
      languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } },
    },
  });
  const good = await eslint.lintText(actual, { filePath: file });
  assert.equal(good[0].errorCount, 0);
  const floating = replaceOnce(
    actual,
    "await contact.invokeOperation('deleteFriend', {",
    "contact.invokeOperation('deleteFriend', {",
  );
  const reports = await eslint.lintText(floating, { filePath: file });
  assert.ok(
    reports
      .flatMap((report) => report.messages)
      .some((message) => message.ruleId === '@typescript-eslint/no-floating-promises'),
  );
});
function diagnostics(replacement, checkedFile = helper) {
  const configPath = resolve(root, 'tsconfig.scripts.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.deepEqual(parsed.errors, []);
  const host = ts.createCompilerHost(parsed.options);
  const originalRead = host.readFile.bind(host);
  host.readFile = (path) => (resolve(path) === checkedFile ? replacement : originalRead(path));
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((item) => item.file && resolve(item.file.fileName) === checkedFile);
}

for (const fixture of [
  {
    name: 'worker-read',
    before: "await client.login({ method: 'restore', uin: '789' });",
    invalid: "await client.login({ method: 'restore', uin: 789 });",
    ignored: "client.login({ method: 'restore', uin: '789' });",
  },
  {
    name: 'worker-error',
    before: "await client.login({ method: 'restore', uin: '789' });",
    invalid: "await client.login({ method: 'restore', uin: 789 });",
    ignored: "client.login({ method: 'restore', uin: '789' });",
  },
  {
    name: 'history-lifecycle',
    before: 'await assert.rejects(client.waitForLogin(), /closed/);',
    invalid: 'await assert.rejects(client.waitForLogin(42), /closed/);',
    ignored: 'assert.rejects(client.waitForLogin(), /closed/);',
  },
  {
    name: 'kernel-session',
    before: 'await f.kernel.prepare();',
    invalid: 'await f.kernel.prepare(42);',
    ignored: 'f.kernel.prepare();',
  },
]) {
  test(`${fixture.name} consumer rejects invalid calls and unobserved lifecycle work without execution`, async () => {
    const file = resolve(root, `scripts/consumers/${fixture.name}-consumer-contract.mjs`);
    const actual = readFileSync(file, 'utf8');
    assert.deepEqual(diagnostics(actual, file), []);
    assert.ok(diagnostics(replaceOnce(actual, fixture.before, fixture.invalid), file).length > 0);
    const eslint = new ESLint({
      cwd: root,
      overrideConfig: {
        languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } },
      },
    });
    const good = await eslint.lintText(actual, { filePath: file });
    assert.equal(good[0].errorCount, 0);
    for (const prefix of ['', 'void ']) {
      const broken = replaceOnce(actual, fixture.before, `${prefix}${fixture.ignored}`);
      const reports = await eslint.lintText(broken, { filePath: file });
      assert.ok(
        reports
          .flatMap((report) => report.messages)
          .some((message) => message.ruleId === '@typescript-eslint/no-floating-promises'),
      );
    }
  });
}

test('consumer compiler gate rejects missing preparation await and fabricated send receipts without running the helper', () => {
  assert.deepEqual(diagnostics(source), [], 'Actual checked helper must be type-correct first');
  const missingAwait = replaceOnce(
    source,
    'const action = await prepareCommand(',
    'const action = prepareCommand(',
  );
  const errors = diagnostics(missingAwait);
  assert.ok(
    errors.some((item) => item.code === 2349),
    'Promise action must not be callable',
  );
  const wrongReceipt = replaceOnce(
    source,
    "return { messageId: '1', sequence: '1', time: 1 };",
    'return undefined;',
  );
  assert.ok(
    diagnostics(wrongReceipt).some((item) => item.code === 2322),
    'Fake send must retain public receipt contract',
  );
});

const factoryHelper = resolve(root, 'scripts/consumers/client-factory-consumer-contract.mjs');
const factorySource = readFileSync(factoryHelper, 'utf8');
test('client factory compiler rejects unawaited construction and invalid options without running its worker', () => {
  assert.deepEqual(diagnostics(factorySource, factoryHelper), []);
  for (const [before, after, code] of [
    [
      'client = await createClient({\n          wrapperPath: wrapper,',
      'client = createClient({\n          wrapperPath: wrapper,',
      2740,
    ],
    ['bridgePath: fixture.explicit ? explicit : undefined,', 'bridgePath: 123,', 2322],
  ]) {
    assert.ok(
      diagnostics(replaceOnce(factorySource, before, after), factoryHelper).some(
        (item) => item.code === code,
      ),
      `Factory verification must reject ${after}`,
    );
  }
});

const groupSearchHelper = resolve(root, 'scripts/consumers/group-search-consumer-contract.mjs');
const groupSearchSource = readFileSync(groupSearchHelper, 'utf8');

test('group-search consumer compiler rejects missing preparation await and invalid match DTO without running its worker', () => {
  assert.deepEqual(diagnostics(groupSearchSource, groupSearchHelper), []);
  assert.ok(
    diagnostics(
      replaceOnce(
        groupSearchSource,
        'const plan = await prepareCommand(',
        'const plan = prepareCommand(',
      ),
      groupSearchHelper,
    ).some((item) => item.code === 2349),
    'The installed CLI plan must retain its asynchronous preparation contract',
  );
  assert.ok(
    diagnostics(
      replaceOnce(groupSearchSource, "name: 'fixture',", 'name: 123,'),
      groupSearchHelper,
    ).some((item) => item.code === 2322),
    'Controlled results must retain the public GroupSearchMatch contract',
  );
});

const groupEssenceHelper = resolve(root, 'scripts/consumers/group-essence-consumer-contract.mjs');
const groupEssenceSource = readFileSync(groupEssenceHelper, 'utf8');

test('group-essence compiler rejects unawaited CLI preparation and incomplete public DTOs without running tickets or IPC', () => {
  assert.deepEqual(diagnostics(groupEssenceSource, groupEssenceHelper), []);
  assert.ok(
    diagnostics(
      replaceOnce(
        groupEssenceSource,
        'const action = await prepareCommand(',
        'const action = prepareCommand(',
      ),
      groupEssenceHelper,
    ).some((item) => item.code === 2349),
    'Promise CLI action must not become callable',
  );
  assert.ok(
    diagnostics(
      replaceOnce(groupEssenceSource, "senderNickname: 'fixture',", 'senderNickname: 123,'),
      groupEssenceHelper,
    ).some((item) => item.code === 2322),
    'The installed worker result must preserve a complete public essence DTO',
  );
  assert.ok(
    diagnostics(
      replaceOnce(
        groupEssenceSource,
        '    removable: false,',
        '    /* Missing required removable property. */',
      ),
      groupEssenceHelper,
    ).some((item) => item.code === 1360),
    'Missing required DTO fields must not pass a faithful adapter check',
  );
});

const filePagesHelper = resolve(root, 'scripts/consumers/group-file-pages-consumer-contract.mjs');
const filePagesSource = readFileSync(filePagesHelper, 'utf8');
test('group file consumer rejects missing metadata, rounded uint64 and unawaited CLI preparation without executing native code', () => {
  assert.deepEqual(diagnostics(filePagesSource, filePagesHelper), []);
  for (const [before, after, code] of [
    ["fileSize: '18446744073709551615',", 'fileSize: 18446744073709551615,', 2322],
    ['    totalFileCount: 1,', '    /* Missing required folder count. */', 1360],
    ['const plan = await prepareCommand(', 'const plan = prepareCommand(', 2349],
  ]) {
    assert.ok(
      diagnostics(replaceOnce(filePagesSource, before, after), filePagesHelper).some(
        (item) => item.code === code,
      ),
      before,
    );
  }
});

const elementHelper = resolve(root, 'scripts/consumers/element-preparation-consumer-contract.mjs');
const elementSource = readFileSync(elementHelper, 'utf8');
test('element preparation compiler rejects unawaited results, wrong variants and unchecked thumbnail paths without running adapters', () => {
  assert.deepEqual(diagnostics(elementSource, elementHelper), []);
  for (const [before, after, code] of [
    ['const prepared = await createImageElement(', 'const prepared = createImageElement(', 2339],
    [
      'assert.equal(prepared.picElement.sourcePath, staged);',
      'assert.equal(prepared.fileElement.sourcePath, staged);',
      2339,
    ],
    ['assert.ok(thumbnailPath);', '/* Missing thumbnail path narrowing. */', 2345],
  ]) {
    assert.ok(
      diagnostics(replaceOnce(elementSource, before, after), elementHelper).some(
        (item) => item.code === code,
      ),
      `Element contract must reject ${after}`,
    );
  }
});

for (const fixture of [
  {
    name: 'client-factory',
    file: factoryHelper,
    source: factorySource,
    invocation: "await openAndClose({ version }, join(auxiliary, 'wrapper.node'), version);",
    ignored: "openAndClose({ version }, join(auxiliary, 'wrapper.node'), version);",
  },
  {
    name: 'face',
    file: helper,
    source,
    invocation: 'await action(client);',
    ignored: 'action(client);',
  },
  {
    name: 'element-preparation',
    file: elementHelper,
    source: elementSource,
    invocation: 'const prepared = await createImageElement(image, allocator);',
    ignored: 'createImageElement(image, allocator); const prepared = undefined;',
  },
  {
    name: 'group-essence',
    file: groupEssenceHelper,
    source: groupEssenceSource,
    invocation: 'const received = await action(client);',
    ignored: 'action(client); const received = undefined;',
  },
  {
    name: 'group-search',
    file: groupSearchHelper,
    source: groupSearchSource,
    invocation: 'const match = await plan(client);',
    ignored: 'plan(client); const match = undefined;',
  },
  {
    name: 'group-file-pages',
    file: filePagesHelper,
    source: filePagesSource,
    invocation: 'assert.deepEqual(await plan(client), page);',
    ignored: 'plan(client);',
  },
]) {
  test(`${fixture.name} typed consumer lint rejects unobserved action Promise without running the helper`, async () => {
    const eslint = new ESLint({
      cwd: root,
      // These lintText calls repeatedly change one in-memory file. CI single-run
      // inference treats later parses as autofixes and loses imported action types.
      // Use the persistent program only here; the actual disk lint gate is unchanged.
      overrideConfig: {
        languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } },
      },
    });
    const good = await eslint.lintText(fixture.source, { filePath: fixture.file });
    assert.equal(good[0].errorCount, 0, 'Actual checked helper must pass its lint gate first');
    for (const prefix of ['', 'void ']) {
      const invocation = `${prefix}${fixture.ignored}`;
      const missingAwait = replaceOnce(fixture.source, fixture.invocation, invocation);
      const results = await eslint.lintText(missingAwait, { filePath: fixture.file });
      assert.ok(
        results[0].messages.some(
          (message) => message.ruleId === '@typescript-eslint/no-floating-promises',
        ),
        `Unobserved action must reject: ${invocation}`,
      );
    }
  });
}

test('collector never executes consumers or scans excluded account executors, and rejects root escape/computed import', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'consumer-static-gate-')));
  try {
    const helpers = join(directory, 'helpers'),
      dist = join(directory, 'dist');
    await mkdir(helpers);
    await mkdir(dist);
    const entry = join(helpers, 'entry.mjs'),
      marker = join(directory, 'executed-marker');
    await writeFile(entry, `throw Error('consumer must never execute'); import './safe.mjs';`);
    await writeFile(
      join(helpers, 'safe.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe'); throw Error('helper must never execute');`,
    );
    await writeFile(
      join(helpers, 'account-executor.mjs'),
      `import(computedAccountPath); throw Error('excluded executor must never be scanned');`,
    );
    const options = { entries: [entry], helperRoots: [helpers], distRoot: dist };
    const collected = collectConsumerModuleReferences(options);
    assert.deepEqual(collected.helpers.map((path) => path.split(/[/\\]/).at(-1)).sort(), [
      'entry.mjs',
      'safe.mjs',
    ]);
    assert.equal(existsSync(marker), false);
    await writeFile(join(directory, 'outside.mjs'), `throw Error('not executed');`);
    await writeFile(entry, `import '../outside.mjs';`);
    assert.throws(() => collectConsumerModuleReferences(options), /escapes reviewed roots/);
    await writeFile(entry, `const path = './safe.mjs'; import(path);`);
    assert.throws(() => collectConsumerModuleReferences(options), /[Cc]omputed.*import/);
    assert.equal(existsSync(marker), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
