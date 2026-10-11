import ts from 'typescript';

export interface AmbientFetchReference {
  line: number;
  expression: string;
}

/** Find runtime acquisition of Node's global fetch, including aliases captured
 * through property access or destructuring. Symbol identity distinguishes local
 * methods named fetch. This is an architecture check, not a JavaScript sandbox.
 */
export function findAmbientFetchReferences(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): AmbientFetchReference[] {
  const ambient = checker.resolveName('fetch', undefined, ts.SymbolFlags.Value, false);
  if (!ambient) throw new Error('Ambient network analysis requires global fetch declarations');
  const references: AmbientFetchReference[] = [];
  function record(node: ts.Node): void {
    references.push({
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      expression: node.getText(source),
    });
  }
  function literalProperty(object: ts.Node, key: ts.Expression): ts.Symbol | undefined {
    const type = checker.getTypeAtLocation(key);
    return type.isStringLiteral()
      ? checker.getPropertyOfType(checker.getTypeAtLocation(object), type.value)
      : undefined;
  }
  function visit(node: ts.Node): void {
    // A type query describes a port; it does not acquire the global implementation.
    if (ts.isTypeNode(node)) return;
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      !ts.isStringLiteral(node.argumentExpression) &&
      literalProperty(node.expression, node.argumentExpression) === ambient
    )
      record(node);
    if (
      ts.isBindingElement(node) &&
      node.propertyName &&
      ts.isComputedPropertyName(node.propertyName) &&
      literalProperty(node.parent, node.propertyName.expression) === ambient
    )
      record(node);
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
      let symbol = checker.getSymbolAtLocation(node);
      if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node)
        symbol = checker.getShorthandAssignmentValueSymbol(node.parent);
      if (
        ts.isBindingElement(node.parent) &&
        node.parent.name === node &&
        !node.parent.propertyName &&
        ts.isObjectBindingPattern(node.parent.parent)
      )
        symbol = checker.getPropertyOfType(
          checker.getTypeAtLocation(node.parent.parent),
          node.text,
        );
      if (symbol === ambient) record(node.parent);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return references;
}
