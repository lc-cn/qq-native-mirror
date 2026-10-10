import ts from 'typescript';

export interface ExtractedDependency {
  specifier: string;
  typeOnly: boolean;
  line: number;
}
/** Syntactic loading boundary, not a proof against arbitrary JavaScript evaluation. */
export function extractSourceDependencies(path: string, source: string) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const dependencies: ExtractedDependency[] = [];
  const violations: string[] = [];
  const factories = new Set(['createRequire']);
  const loaders = new Set(['require']);
  const namespaces = new Set<string>();
  const add = (node: ts.Node, specifier: string, typeOnly: boolean) =>
    dependencies.push({
      specifier,
      typeOnly,
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
    });
  const reject = (node: ts.Node) =>
    violations.push(
      `${path}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: unreviewed module loading ${node.getText(tree)}`,
    );
  for (const node of tree.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      !['node:module', 'module'].includes(node.moduleSpecifier.text)
    )
      continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements)
        if ((item.propertyName ?? item.name).text === 'createRequire')
          factories.add(item.name.text);
  }
  function factory(node: ts.Expression): boolean {
    return ts.isIdentifier(node)
      ? factories.has(node.text)
      : ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          namespaces.has(node.expression.text) &&
          node.name.text === 'createRequire';
  }
  function loader(node: ts.Expression): boolean {
    return ts.isIdentifier(node)
      ? loaders.has(node.text)
      : ts.isCallExpression(node) && factory(node.expression);
  }
  // Follow simple local aliases to keep renamed CommonJS loaders visible.
  for (let pass = 0; pass < tree.statements.length + 1; pass++) {
    function aliases(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) {
          if (factory(node.initializer)) factories.add(node.name.text);
          if (loader(node.initializer)) loaders.add(node.name.text);
          if (
            ts.isPropertyAccessExpression(node.initializer) &&
            loader(node.initializer.expression) &&
            node.initializer.name.text === 'resolve'
          )
            loaders.add(node.name.text);
        } else if (ts.isObjectBindingPattern(node.name) && loader(node.initializer))
          for (const binding of node.name.elements)
            if (ts.isIdentifier(binding.name)) loaders.add(binding.name.text);
      }
      ts.forEachChild(node, aliases);
    }
    aliases(tree);
  }
  function approved(node: ts.CallExpression): boolean {
    const text = node.getText(tree).replace(/\s+/g, '');
    if (
      [
        'src/features/media/record-codec-loader.ts',
        'src/features/media/video-codec-loader.ts',
      ].includes(path) &&
      text === 'import(pathToFileURL(file).href)'
    )
      return true;
    if (
      path === 'src/features/media/video-codec-loader.ts' &&
      text === 'createRequire(import.meta.url)(file)'
    )
      return true;
    // Manifest resolution selects an installed platform package, not arbitrary execution.
    if (
      path === 'src/native/native-package.ts' &&
      text === 'createRequire(import.meta.url).resolve(`${name}/manifest.json`)'
    )
      return true;
    return false;
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause,
        bindings = clause?.namedBindings;
      const inline =
        !clause?.name &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((e) => e.isTypeOnly);
      add(node, node.moduleSpecifier.text, clause?.isTypeOnly === true || inline === true);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      const inline =
        clause &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((e) => e.isTypeOnly);
      add(node, node.moduleSpecifier.text, node.isTypeOnly || inline === true);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      add(node, node.argument.literal.text, true);
    else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!))
          add(node, node.arguments[0]!.text, false);
        else if (!approved(node)) reject(node);
      } else if (
        loader(node.expression) ||
        ((ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression)) &&
          loader(node.expression.expression))
      ) {
        if (!approved(node)) reject(node);
      } else if (factory(node.expression)) {
        const parent = node.parent;
        const outer = ts.isPropertyAccessExpression(parent) ? parent.parent : parent;
        if (!ts.isCallExpression(outer) || !approved(outer)) reject(node);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return { dependencies, violations };
}
