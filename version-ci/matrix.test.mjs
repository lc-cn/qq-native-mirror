import assert from 'node:assert/strict';
import test from 'node:test';
import { linuxVersionMatrix } from './matrix.mjs';

test('one main matrix retains every public version/architecture and adds separate candidates', () => {
  const baseline = linuxVersionMatrix('published-baseline').include;
  const current = linuxVersionMatrix('current-source').include;
  assert.equal(baseline.length, 4);
  assert.deepEqual(
    current.filter((entry) => entry.catalog === 'public-default'),
    baseline,
  );
  assert.equal(new Set(baseline.map((entry) => `${entry.version}/${entry.arch}`)).size, 4);
  assert.deepEqual(
    current
      .filter((entry) => entry.catalog === 'legacy-bridge-candidate')
      .map((entry) => entry.arch)
      .sort(),
    ['arm64', 'x64'],
  );
  assert.equal(current.length, 6);
  assert.throws(() => linuxVersionMatrix('unknown'));
});
