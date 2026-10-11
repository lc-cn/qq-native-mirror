import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.isFile() && path.endsWith('.ts')
        ? [path]
        : [];
  });
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
