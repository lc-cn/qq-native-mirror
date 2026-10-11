import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ESLint } from 'eslint';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const filePath = fileURLToPath(
  new URL('../src/runtime/authentication-attempt.ts', import.meta.url),
);

await test('source lint rejects background Promise abandonment including void without executing it', async () => {
  const source = await readFile(filePath, 'utf8');
  const invocation = 'observeBackgroundTask(this.onConnected());';
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
  observeBackgroundTask(onMessage(message));
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

/** Check the two parent notification chains, not arbitrary Promise semantics.
 * @param {string} source
 * @returns {string[]}
 */
function parentTaskOwnershipViolations(source) {
  const tree = ts.createSourceFile('client-lifecycle.ts', source, ts.ScriptTarget.Latest, true);
  const host = ts.createCompilerHost({ noResolve: true, noLib: true });
  host.getSourceFile = (fileName) => (fileName === 'client-lifecycle.ts' ? tree : undefined);
  const checker = ts
    .createProgram(['client-lifecycle.ts'], { noResolve: true, noLib: true }, host)
    .getTypeChecker();
  /** @type {Set<ts.Symbol>} */
  const imported = new Set();
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== './background-task.ts' ||
      statement.importClause?.isTypeOnly
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        if (
          !element.isTypeOnly &&
          (element.propertyName?.text ?? element.name.text) === 'observeBackgroundTask'
        ) {
          const symbol = checker.getSymbolAtLocation(element.name);
          if (symbol) imported.add(symbol);
        }
  }
  /** @param {ts.Identifier} identifier */
  const isImportedObserver = (identifier) => {
    const symbol = checker.getSymbolAtLocation(identifier);
    return symbol !== undefined && imported.has(symbol);
  };
  /** @type {string[]} */
  const violations = [];
  for (const event of ['loginError', 'reconnect-error']) {
    /** @type {ts.CallExpression[]} */
    const notifications = [];
    /** @param {ts.Node} node */
    function find(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'forward' &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === event
      )
        notifications.push(node);
      ts.forEachChild(node, find);
    }
    find(tree);
    if (notifications.length !== 1) violations.push(`Expected one ${event} notification`);
    for (const notification of notifications) {
      /** @type {ts.Node|undefined} */
      let node = notification.parent;
      while (
        node &&
        !(
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ['then', 'catch'].includes(node.expression.name.text)
        )
      )
        node = node.parent;
      if (!node || !ts.isCallExpression(node)) {
        violations.push(`${event} lacks its owned Promise chain`);
        continue;
      }
      const receiver = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.expression
        : undefined;
      const method =
        receiver &&
        ts.isCallExpression(receiver) &&
        ts.isPropertyAccessExpression(receiver.expression)
          ? receiver.expression
          : undefined;
      if (
        !method ||
        method.expression.kind !== ts.SyntaxKind.ThisKeyword ||
        method.name.text !== (event === 'loginError' ? '#startLogin' : '#beginReconnect')
      )
        violations.push(`${event} must belong to its reviewed login/reconnect operation`);
      const parent = node.parent;
      if (
        !ts.isCallExpression(parent) ||
        !ts.isIdentifier(parent.expression) ||
        !isImportedObserver(parent.expression) ||
        parent.arguments.length !== 1 ||
        parent.arguments[0] !== node
      )
        violations.push(`${event} chain must be consumed by the reviewed background task observer`);
    }
  }
  return violations;
}

await test('parent notification Promise chains require the imported background task owner', async () => {
  const path = fileURLToPath(new URL('../src/runtime/client-lifecycle.ts', import.meta.url));
  const source = await readFile(path, 'utf8');
  assert.deepEqual(parentTaskOwnershipViolations(source), []);
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  /** @type {ts.CallExpression[]} */
  const wrappers = [];
  /** @param {ts.Node} node */
  function collect(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'observeBackgroundTask'
    )
      wrappers.push(node);
    ts.forEachChild(node, collect);
  }
  collect(tree);
  assert.equal(wrappers.length, 2);
  for (const wrapper of wrappers) {
    assert.equal(wrapper.arguments.length, 1);
    const argument = wrapper.arguments[0];
    assert.ok(argument);
    const shadow =
      source.slice(0, wrapper.getStart(tree)) +
      `((observeBackgroundTask) => observeBackgroundTask(${argument.getText(tree)}))((task) => {})` +
      source.slice(wrapper.end);
    assert.ok(
      parentTaskOwnershipViolations(shadow).length > 0,
      'A local same-named callback cannot impersonate the imported observer',
    );
    for (const prefix of ['', 'void ']) {
      const mutant =
        source.slice(0, wrapper.getStart(tree)) +
        prefix +
        argument.getText(tree) +
        source.slice(wrapper.end);
      assert.ok(
        parentTaskOwnershipViolations(mutant).length > 0,
        'Unobserved notification chain must fail ownership',
      );
    }
  }
  const importAnchor = "import { observeBackgroundTask } from './background-task.ts';";
  assert.equal(source.split(importAnchor).length, 2);
  for (const replacement of [
    "import { fake as observeBackgroundTask } from './background-task.ts';",
    "export { observeBackgroundTask } from './background-task.ts';",
    "import { observeBackgroundTask } from './cleanup.ts';",
  ])
    assert.ok(parentTaskOwnershipViolations(source.replace(importAnchor, replacement)).length > 0);
});
