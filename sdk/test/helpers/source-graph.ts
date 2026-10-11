import assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSourceDependencies } from './source-dependencies.ts';

// One static inventory shared by all architecture assertions. No SDK module is executed.
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sourceRoot = join(projectRoot, 'src');
interface Dependency {
  specifier: string;
  typeOnly: boolean;
  line: number;
  target?: string;
}
export function sourceFiles(directory: string): string[] {
  const invalid = (path: string) =>
    new Error(`Unreviewed source entry: ${path}; expected regular .ts files and directories.`);
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw invalid(directory);
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    // A compiler can follow imported files and links outside its root include pattern.
    // Fail before graph construction instead of silently leaving those modules unchecked.
    if (entry.isSymbolicLink()) throw invalid(path);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith('.ts')) files.push(path);
    else throw invalid(path);
  }
  return files;
}
export const files = sourceFiles(sourceRoot).sort();
const fileSet = new Set(files);
export const label = (path: string) => relative(projectRoot, path).replaceAll('\\', '/');
export function relativeTarget(from: string, specifier: string): string | undefined {
  const path = resolve(dirname(from), specifier);
  const candidates = [path, path.replace(/\.js$/, '.ts'), `${path}.ts`, join(path, 'index.ts')];
  return candidates.find((candidate) => fileSet.has(candidate));
}
function dependencies(path: string): Dependency[] {
  const extracted = extractSourceDependencies(label(path), readFileSync(path, 'utf8'));
  assert.deepEqual(extracted.violations, [], extracted.violations.join('\n'));
  return extracted.dependencies.map((edge) => ({
    ...edge,
    ...(edge.specifier.startsWith('.') ? { target: relativeTarget(path, edge.specifier) } : {}),
  }));
}

export const graph = new Map(files.map((path) => [path, dependencies(path)]));
export const runtimeEdges = (path: string) => graph.get(path)!.filter((edge) => !edge.typeOnly);
