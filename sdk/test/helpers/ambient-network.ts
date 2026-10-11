import ts from 'typescript';
import { findAmbientReferences } from './ambient-references.ts';
import type { AmbientReference } from './ambient-references.ts';
export type AmbientFetchReference = AmbientReference;
export function findAmbientFetchReferences(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): AmbientFetchReference[] {
  const ambient = checker.resolveName('fetch', undefined, ts.SymbolFlags.Value, false);
  if (!ambient) throw new Error('Ambient network analysis requires global fetch declarations');
  return findAmbientReferences(source, checker, ambient);
}
