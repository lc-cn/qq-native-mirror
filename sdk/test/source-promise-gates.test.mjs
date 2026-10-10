import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../', import.meta.url));
const filePath = fileURLToPath(
  new URL('../src/runtime/authentication-attempt.ts', import.meta.url),
);

test('source lint rejects background Promise abandonment including void without executing it', async () => {
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
