import ts from 'typescript';
import { findAmbientReferences } from './ambient-references.ts';
import type { AmbientReference } from './ambient-references.ts';
/** Builtin acquisition must use reviewed explicit imports. */
export function findAmbientModuleLoadingReferences(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): AmbientReference[] {
  const process = checker.resolveName('process', undefined, ts.SymbolFlags.Value, false);
  const ambient =
    process &&
    checker.getPropertyOfType(
      checker.getTypeOfSymbolAtLocation(process, source),
      'getBuiltinModule',
    );
  if (!ambient)
    throw new Error('Ambient module analysis requires Node getBuiltinModule declarations');
  return findAmbientReferences(source, checker, ambient);
}
