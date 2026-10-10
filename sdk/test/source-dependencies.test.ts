import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSourceDependencies } from './helpers/source-dependencies.ts';
test('computed namespace factories and aliases cannot hide CommonJS loading', () => {
  for (const code of [
    `import * as mod from 'node:module'; const load=mod['createRequire'](import.meta.url);load('../native/x.js');`,
    `import * as mod from 'module';const factory=mod['createRequire'];const alias=factory;const load=alias(import.meta.url);load('node:fs');`,
    `import * as mod from 'node:module'; const key='createRequire';mod[key](import.meta.url)('node:fs');`,
    `import {createRequire} from 'node:module';const load=createRequire(import.meta.url);const resolve=load['resolve'];resolve('node:fs');`,
  ])
    assert.ok(
      extractSourceDependencies('src/features/groups/new-loader.ts', code).violations.length > 0,
      code,
    );
});
test('static and type-only dependencies keep accurate edges', () => {
  const result = extractSourceDependencies(
    'src/example.ts',
    `import type {A} from './types.ts';import {type B} from './b.ts';export type {C} from './c.ts';const value=import('./runtime.ts');type D=import('./d.ts').D;`,
  );
  assert.deepEqual(result.violations, []);
  assert.deepEqual(
    result.dependencies.map(({ specifier, typeOnly }) => ({ specifier, typeOnly })),
    [
      { specifier: './types.ts', typeOnly: true },
      { specifier: './b.ts', typeOnly: true },
      { specifier: './c.ts', typeOnly: true },
      { specifier: './runtime.ts', typeOnly: false },
      { specifier: './d.ts', typeOnly: true },
    ],
  );
});
test('only exact reviewed loader syntax retains its scoped exemption', () => {
  const approved = `import {createRequire} from 'node:module';createRequire(import.meta.url)(file);`;
  assert.deepEqual(
    extractSourceDependencies('src/features/media/video-codec-loader.ts', approved).violations,
    [],
  );
  assert.ok(
    extractSourceDependencies('src/features/media/new-codec-loader.ts', approved).violations
      .length > 0,
  );
  assert.ok(
    extractSourceDependencies(
      'src/features/media/video-codec-loader.ts',
      `import * as mod from 'node:module';mod['createRequire'](import.meta.url)(file);`,
    ).violations.length > 0,
  );
});
