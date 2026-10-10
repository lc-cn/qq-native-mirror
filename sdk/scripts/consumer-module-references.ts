import ts from 'typescript';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

export interface ConsumerModuleException {
  file: string;
  expression: string;
  modules: readonly string[];
  reason: string;
}
export interface ConsumerModuleReferencesOptions {
  entries: readonly string[];
  distRoot: string;
  helperRoots: readonly string[];
  exceptions?: readonly ConsumerModuleException[];
}
export interface ConsumerModuleReference {
  path: string;
  file: string;
  line: number;
}
export interface ConsumerModuleExceptionUse {
  file: string;
  line: number;
  reason: string;
  modules: readonly string[];
}
/** Static syntax gate only. It never imports or executes a consumer or installed SDK. */
export function collectConsumerModuleReferences(options: ConsumerModuleReferencesOptions) {
  const roots = options.helperRoots.map((root) => realpathSync(root));
  const usedExceptions = new Set<ConsumerModuleException>();
  const visited = new Set<string>();
  const references: ConsumerModuleReference[] = [];
  const exceptions: ConsumerModuleExceptionUse[] = [];
  const inside = (file: string, root: string) => {
    const path = relative(resolve(root), file).replaceAll('\\', '/');
    return !isAbsolute(path) && path !== '..' && !path.startsWith('../');
  };
  const literal = (node: ts.Node | undefined): string | undefined =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;
  const walk = (input: string) => {
    const file = realpathSync(input);
    if (!roots.some((root) => inside(file, root)))
      throw new Error(`${file}: Entry escapes reviewed roots`);
    if (visited.has(file)) return;
    visited.add(file);
    const tree = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const loadBodies = new Set<ts.Node>();
    const loaders = new Set<ts.VariableDeclaration>();
    const bindings = new Map<ts.Node, Map<string, ts.Node>>();
    const scope = (node: ts.Node): ts.Node => {
      let owner = node.parent;
      while (owner && !ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
      return owner ?? tree;
    };
    const fail = (node: ts.Node, message: string): never => {
      throw new Error(
        `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: ${message}`,
      );
    };
    const add = (node: ts.Node, path: string) => {
      const normalized = path.replaceAll('\\', '/');
      const target = resolve(options.distRoot, normalized);
      if (!inside(target, options.distRoot) || !normalized.endsWith('.js'))
        fail(node, 'Invalid installed module path');
      references.push({
        path: normalized,
        file,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      });
    };
    const joined = (node: ts.Node): string | undefined => {
      if (
        !ts.isCallExpression(node) ||
        !ts.isIdentifier(node.expression) ||
        node.expression.text !== 'join'
      )
        return;
      const parts = node.arguments.map(literal);
      const index = parts.findIndex(
        (part) => part === 'dist' || part?.startsWith('dist/') || part?.includes('/dist/'),
      );
      if (index !== 1 || !ts.isIdentifier(node.arguments[0])) return;
      const first = parts[index]!;
      if (parts.slice(index).some((part) => part === undefined)) return;
      return [first.slice(first.indexOf('dist') + 4).replace(/^\//, ''), ...parts.slice(index + 1)]
        .filter(Boolean)
        .join('/');
    };
    const urlJoin = (node: ts.Node | undefined): ts.CallExpression | undefined => {
      if (!node || !ts.isPropertyAccessExpression(node) || node.name.text !== 'href') return;
      const url = node.expression;
      if (
        !ts.isCallExpression(url) ||
        !ts.isIdentifier(url.expression) ||
        url.expression.text !== 'pathToFileURL' ||
        url.arguments.length !== 1
      )
        return;
      const join = url.arguments[0];
      if (
        !ts.isCallExpression(join) ||
        !ts.isIdentifier(join.expression) ||
        join.expression.text !== 'join'
      )
        return;
      return join;
    };
    const discover = (node: ts.Node) => {
      if (
        (ts.isVariableDeclaration(node) ||
          ts.isParameter(node) ||
          ts.isFunctionDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name)
      ) {
        const owner = ts.isParameter(node) ? node.parent : scope(node);
        const map = bindings.get(owner) ?? new Map<string, ts.Node>();
        map.set(node.name.text, node);
        bindings.set(owner, map);
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isArrowFunction(node.initializer)
      ) {
        const fn = node.initializer;
        if (
          fn.parameters.length === 1 &&
          ts.isIdentifier(fn.parameters[0].name) &&
          ts.isCallExpression(fn.body) &&
          fn.body.expression.kind === ts.SyntaxKind.ImportKeyword &&
          fn.body.arguments.length === 1
        ) {
          const join = urlJoin(fn.body.arguments[0]);
          if (
            join &&
            join.arguments.length === 3 &&
            ts.isIdentifier(join.arguments[0]) &&
            literal(join.arguments[1]) === 'dist' &&
            ts.isIdentifier(join.arguments[2]) &&
            join.arguments[2].text === fn.parameters[0].name.text
          ) {
            loaders.add(node);
            loadBodies.add(fn.body);
          }
        }
      }
      ts.forEachChild(node, discover);
    };
    discover(tree);
    const loaderParameters = new Set<ts.ParameterDeclaration>();
    const bindingFor = (node: ts.Node, name: string): ts.Node | undefined => {
      let owner: ts.Node | undefined = node;
      while (owner) {
        const binding = bindings.get(owner)?.get(name);
        if (binding) return binding;
        owner = owner.parent;
      }
      return undefined;
    };
    const loaderFor = (node: ts.Node, name: string): boolean => {
      const binding = bindingFor(node, name);
      return (
        binding !== undefined &&
        ((ts.isVariableDeclaration(binding) && loaders.has(binding)) ||
          (ts.isParameter(binding) && loaderParameters.has(binding)))
      );
    };
    let changed = true;
    while (changed) {
      changed = false;
      const propagate = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const fn = bindingFor(node, node.expression.text);
          if (fn && ts.isFunctionDeclaration(fn))
            node.arguments.forEach((argument, index) => {
              const parameter = fn.parameters[index];
              if (
                parameter &&
                ts.isIdentifier(argument) &&
                loaderFor(node, argument.text) &&
                !loaderParameters.has(parameter)
              ) {
                loaderParameters.add(parameter);
                changed = true;
              }
            });
        }
        ts.forEachChild(node, propagate);
      };
      propagate(tree);
    }
    const verifyPassedLoaders = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const fn = bindingFor(node, node.expression.text);
        if (fn && ts.isFunctionDeclaration(fn))
          fn.parameters.forEach((parameter, index) => {
            if (!loaderParameters.has(parameter)) return;
            if (fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
              fail(node, 'Exported installed loader forwarding');
            const argument = node.arguments[index];
            if (!argument || !ts.isIdentifier(argument) || !loaderFor(node, argument.text))
              fail(node, 'Unreviewed installed loader forwarding');
          });
      }
      ts.forEachChild(node, verifyPassedLoaders);
    };
    verifyPassedLoaders(tree);
    const verifyLoaderUse = (node: ts.Node) => {
      if (ts.isIdentifier(node) && loaderFor(node, node.text)) {
        const parent = node.parent;
        const declaration =
          (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node;
        const invocation = ts.isCallExpression(parent) && parent.expression === node;
        let forwarding = false;
        if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression)) {
          const fn = bindingFor(parent, parent.expression.text);
          const index = parent.arguments.indexOf(node);
          forwarding = !!(
            fn &&
            ts.isFunctionDeclaration(fn) &&
            index >= 0 &&
            fn.parameters[index] &&
            loaderParameters.has(fn.parameters[index])
          );
        }
        if (!declaration && !invocation && !forwarding)
          fail(node, 'Unreviewed installed loader escape');
      }
      ts.forEachChild(node, verifyLoaderUse);
    };
    verifyLoaderUse(tree);

    const follow = (node: ts.Node, specifier: string) => {
      if (
        specifier.startsWith('/') ||
        specifier.startsWith('file:') ||
        /^[A-Za-z]:/.test(specifier)
      )
        fail(node, 'Unreviewed absolute helper import');
      if (specifier.startsWith('.')) {
        if (specifier.includes('/dist/')) {
          add(node, specifier.slice(specifier.indexOf('/dist/') + 6));
          return;
        }
        const target = realpathSync(resolve(dirname(file), specifier));
        if (!roots.some((root) => inside(target, root)))
          fail(node, 'Helper import escapes reviewed roots');
        walk(target);
      }
    };
    const visit = (node: ts.Node) => {
      if (loadBodies.has(node)) return;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const specifier = literal(node.moduleSpecifier);
        if (specifier === undefined) fail(node, 'Computed helper import');
        follow(node, specifier!);
      }
      if (ts.isCallExpression(node)) {
        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'load' &&
          !loaderFor(node, node.expression.text)
        )
          fail(node, 'Unreviewed installed loader binding');
        if (ts.isIdentifier(node.expression) && loaderFor(node, node.expression.text)) {
          const path = node.arguments.length === 1 ? literal(node.arguments[0]) : undefined;
          if (path === undefined) fail(node, 'Computed installed loader argument');
          add(node, path!);
        }
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const specifier = literal(node.arguments[0]);
          if (specifier !== undefined) follow(node, specifier);
          else {
            const argument = node.arguments[0];
            const join = urlJoin(argument);
            const path = join && joined(join);
            const found = path !== undefined;
            if (found) add(node, path);
            if (!found) {
              const text = node.getText(tree).replace(/\s/g, '');
              const exception = options.exceptions?.find(
                (value) =>
                  realpathSync(value.file) === file && value.expression.replace(/\s/g, '') === text,
              );
              if (!exception || !exception.reason) fail(node, 'Unreviewed computed import');
              usedExceptions.add(exception!);
              for (const path of exception!.modules) add(node, path);
              exceptions.push({
                reason: exception!.reason,
                modules: [...exception!.modules],
                file,
                line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  };
  options.entries.forEach(walk);
  const program = ts.createProgram([...visited], {
    allowJs: true,
    noResolve: true,
    noLib: true,
    noEmit: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const diagnostic = program.getSyntacticDiagnostics()[0];
  if (diagnostic) {
    const file = diagnostic.file;
    const line =
      file && diagnostic.start !== undefined
        ? file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
        : 1;
    throw new Error(
      `${file?.fileName ?? 'Consumer closure'}:${line}: Invalid consumer syntax (TS${diagnostic.code})`,
    );
  }

  for (const exception of options.exceptions ?? [])
    if (!usedExceptions.has(exception))
      throw new Error(`${exception.file}: Unused computed import exception`);
  return {
    references,
    helpers: [...visited],
    exceptions,
    missing: [
      ...new Set(
        references
          .filter((ref) => {
            try {
              return !statSync(resolve(options.distRoot, ref.path)).isFile();
            } catch {
              return true;
            }
          })
          .map((ref) => ref.path),
      ),
    ],
  };
}
