import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../', import.meta.url));
const filePath = fileURLToPath(
  new URL('../src/runtime/authentication-attempt.ts', import.meta.url),
);

await test('source lint rejects background Promise abandonment including void without executing it', async () => {
  const source = await readFile(filePath, 'utf8');
  const invocation = 'observeWorkerTask(this.onConnected());';
  assert.equal(source.split(invocation).length, 2);
  const eslint = new ESLint({
    cwd: root,
    overrideConfig: {
      languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } },
    },
  });
  const good = await eslint.lintText(source, { filePath });
  assert.equal(good[0].errorCount, 0);
  for (const prefix of ['', 'void ']) {
    const mutant = source.replace(invocation, `${prefix}this.onConnected();`);
    const [result] = await eslint.lintText(mutant, { filePath });
    assert.ok(
      result.messages.some(
        (message) => message.ruleId === '@typescript-eslint/no-floating-promises',
      ),
      `Source gate must reject abandoned task: ${prefix}this.onConnected()`,
    );
  }
});

await test('source lint rejects an async IPC listener whose Promise EventEmitter cannot observe', async () => {
  const workerPath = fileURLToPath(new URL('../src/worker.ts', import.meta.url));
  const source = await readFile(workerPath, 'utf8');
  const listener = `process.on('message', (message: unknown) => {
  // Call immediately: cancellation must not wait behind a dispatch microtask.
  observeWorkerTask(onMessage(message));
});`;
  assert.equal(source.split(listener).length, 2);
  const eslint = new ESLint({
    cwd: root,
    overrideConfig: {
      languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } },
    },
  });
  const good = await eslint.lintText(source, { filePath: workerPath });
  assert.equal(good[0].errorCount, 0);
  const [mutant] = await eslint.lintText(
    source.replace(listener, "process.on('message', onMessage);"),
    {
      filePath: workerPath,
    },
  );
  assert.ok(
    mutant.messages.some((message) => message.ruleId === '@typescript-eslint/no-misused-promises'),
  );
});
