import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureGroupFilePage,
  captureGroupFileList,
} from '../../../src/features/groups/files/group-file-input.ts';

test('group file inputs capture native defaults and decimal identity without coercion', () => {
  assert.deepEqual(captureGroupFilePage('000123'), {
    groupId: '000123',
    params: {
      sortType: 1,
      fileCount: 50,
      startIndex: 0,
      sortOrder: 2,
      showOnlinedocFolder: 0,
    },
  });
  const options = {
    folderId: 'opaque-folder',
    sortType: -0x80000000,
    fileCount: 1000,
    startIndex: 0xffffffff,
    sortOrder: 0xffffffff,
    showOnlinedocFolder: 0xffffffff,
  };
  const captured = captureGroupFilePage('18446744073709551615', options);
  options.folderId = 'changed';
  assert.equal(captured.params.folderId, 'opaque-folder');
  assert.equal(captured.params.startIndex, 0xffffffff);
  assert.equal(captureGroupFileList('123').maxPages, 20);
  assert.equal(captureGroupFileList('123', { maxPages: 1000 }).params.startIndex, 0);
});

test('group file inputs reject getters, unknown keys and invalid widths before any effect', () => {
  let getters = 0;
  for (const field of [
    'folderId',
    'sortType',
    'fileCount',
    'startIndex',
    'sortOrder',
    'showOnlinedocFolder',
  ]) {
    const options = Object.defineProperty({}, field, {
      get() {
        getters++;
        return 1;
      },
      enumerable: true,
    });
    assert.throws(() => captureGroupFilePage('123', options), /data properties/);
  }
  assert.equal(getters, 0);
  for (const options of [
    { folderId: '' },
    { folderId: null },
    { sortType: -0x80000001 },
    { sortType: 0x80000000 },
    { fileCount: 0 },
    { fileCount: 1001 },
    { fileCount: '50' },
    { startIndex: -1 },
    { startIndex: 0x100000000 },
    { sortOrder: 1.5 },
    { showOnlinedocFolder: true },
    { sortType: Number.NaN },
    { unknown: 0 },
    { [Symbol('unknown')]: 0 },
  ])
    assert.throws(() => captureGroupFilePage('123', options));
  for (const group of [
    '0',
    '18446744073709551616',
    123,
    {
      toString() {
        throw Error('must not coerce');
      },
    },
  ])
    assert.throws(() => captureGroupFilePage(group));
  for (const options of [
    { startIndex: 1 },
    { maxPages: 0 },
    { maxPages: 1001 },
    { maxPages: '20' },
  ])
    assert.throws(() => captureGroupFileList('123', options));
});
