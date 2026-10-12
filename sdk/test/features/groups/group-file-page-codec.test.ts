import assert from 'node:assert/strict';
import test from 'node:test';
import { captureGroupFileCallback } from '../../../src/features/groups/files/group-file-page-codec.ts';

const folder = () => ({
  folderId: 'folder',
  parentFolderId: '',
  folderName: 'name',
  createTime: 0,
  modifyTime: 0xffff_ffff,
  createUin: '0',
  creatorName: '',
  totalFileCount: 1,
  modifyUin: '18446744073709551615',
  modifyName: '',
  usedSpace: '0',
});
const file = () => ({
  fileModelId: '0',
  fileId: 'file',
  fileName: 'name',
  fileSize: '18446744073709551615',
  busId: 0xffff_ffff,
  uploadedSize: '0',
  uploadTime: 0,
  deadTime: 1,
  modifyTime: 2,
  downloadTimes: 3,
  sha: '',
  sha3: '',
  md5: '',
  uploaderLocalPath: null,
  uploaderName: '',
  uploaderUin: '0',
  parentFolderId: null,
  localPath: '/native/path',
  transStatus: 0,
  transType: 0xffff_ffff,
  elementId: '18446744073709551615',
  isFolder: false,
});
const row = () => ({ peerId: '123', type: -0x8000_0000, folderInfo: folder(), fileInfo: file() });
const callback = (item: unknown = [row()]) => ({
  reqId: 0,
  retCode: 0,
  retMsg: '',
  clientWording: '',
  isEnd: false,
  item,
  allFileCount: 0xffff_ffff,
  nextIndex: 0,
});
function body(raw: unknown) {
  const captured = captureGroupFileCallback(raw);
  assert.ok(captured?.outcome.ok);
  return captured.outcome.body;
}
function rejected(raw: unknown, token = 0) {
  const captured = captureGroupFileCallback(raw);
  assert.equal(captured?.reqId, token);
  assert.ok(captured && !captured.outcome.ok);
  assert.equal(captured.outcome.error.message, 'Invalid native group file callback');
  assert.equal(Reflect.get(captured.outcome.error, 'code'), 'invalid-result');
  return captured;
}

test('copies all33 carrier fields, widths, local paths and independent carriers', () => {
  const rows = [row()];
  const raw = callback(rows);
  const captured = body(raw);
  assert.deepEqual(captured.items, [
    { groupId: '123', type: -0x8000_0000, folderInfo: folder(), fileInfo: file() },
  ]);
  assert.equal(Object.keys(captured.items[0]!.folderInfo!).length, 11);
  assert.equal(Object.keys(captured.items[0]!.fileInfo!).length, 22);
  rows[0]!.folderInfo.folderName = 'changed';
  rows[0]!.fileInfo.localPath = 'changed';
  rows.push(row());
  raw.isEnd = true;
  assert.equal(captured.items.length, 1);
  assert.equal(captured.items[0]!.folderInfo!.folderName, 'name');
  assert.equal(captured.items[0]!.fileInfo!.localPath, '/native/path');
  assert.equal(captured.isEnd, false);
  for (const [folderInfo, fileInfo] of [
    [null, null],
    [folder(), null],
    [null, file()],
  ]) {
    const result = body(callback([{ ...row(), folderInfo, fileInfo }]));
    assert.deepEqual(result.items[0], { groupId: '123', type: -0x8000_0000, folderInfo, fileInfo });
  }
});

test('null optional values accepted, undefined and absent own fields rejected', () => {
  for (const field of ['parentFolderId', 'uploaderLocalPath']) {
    for (const value of [undefined, 0, false])
      rejected(callback([{ ...row(), fileInfo: { ...file(), [field]: value } }]));
    body(callback([{ ...row(), fileInfo: { ...file(), [field]: '' } }]));
  }
  rejected(callback([{ ...row(), folderInfo: undefined }]));
  rejected(callback([{ ...row(), fileInfo: undefined }]));
  const inherited = Object.create(file()) as object;
  rejected(callback([{ ...row(), fileInfo: inherited }]));
});

test('invalid late row rejects whole snapshot; sparse arrays and array accessors never execute', () => {
  rejected(callback([row(), { ...row(), peerId: 'invalid' }]));
  rejected(callback(new Array(1)));
  let reads = 0;
  const rows = [row()];
  Object.defineProperty(rows, '0', {
    get() {
      reads++;
      throw new Error('private');
    },
  });
  rejected(callback(rows));
  const lengthTrap = new Proxy([row()], {
    get(target, key, receiver) {
      if (key === 'length') {
        reads++;
        throw new Error('private');
      }
      return Reflect.get(target, key, receiver);
    },
  });
  body(callback(lengthTrap));
  assert.equal(reads, 0);
  rejected(callback(new Array(10_001)));
});

test('reqId capture precedes body and associates errors only with their own token', () => {
  for (const reqId of [-1, 0x1_0000_0000, 0.5, '0', undefined])
    assert.equal(captureGroupFileCallback({ ...callback(), reqId }), undefined);
  let reads = 0;
  const raw = callback();
  Object.defineProperty(raw, 'reqId', {
    get() {
      reads++;
      return 0;
    },
  });
  assert.equal(captureGroupFileCallback(raw), undefined);
  const malformed = { ...callback(), reqId: 17 };
  Object.defineProperty(malformed, 'item', {
    get() {
      reads++;
      throw new Error('secret');
    },
  });
  rejected(malformed, 17);
  assert.equal(reads, 0);
  const trap = new Proxy(
    { ...callback(), reqId: 21 },
    {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'item') throw new Error('sensitive');
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  rejected(trap, 21);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(captureGroupFileCallback(revoked.proxy), undefined);
});

test('nonzero int32 status retains only numeric code, never native wording', () => {
  const captured = captureGroupFileCallback({
    ...callback(),
    retCode: -7,
    retMsg: 'secret',
    clientWording: 'private',
  });
  assert.ok(captured && !captured.outcome.ok);
  assert.equal(captured.outcome.error.message, 'Native group file query rejected');
  assert.equal(Reflect.get(captured.outcome.error, 'code'), -7);
  assert.ok(!JSON.stringify(captured).includes('secret'));
  for (const retCode of ['0', 0x8000_0000, -0x8000_0001, NaN]) rejected({ ...callback(), retCode });
});

test('uint64 decimal strings and exact native scalar types checked', () => {
  for (const peerId of ['0', '18446744073709551615']) body(callback([{ ...row(), peerId }]));
  for (const peerId of ['18446744073709551616', '-1', '1.5', '', 123, 123n])
    rejected(callback([{ ...row(), peerId }]));
  for (const patch of [
    { isEnd: 1 },
    { nextIndex: -1 },
    { allFileCount: 0x1_0000_0000 },
    { retMsg: null },
    { clientWording: undefined },
  ])
    rejected({ ...callback(), ...patch });
  rejected(callback([{ ...row(), type: 0x8000_0000 }]));
  const empty = body(callback([]));
  assert.deepEqual(empty.items, []);
  assert.equal(empty.isEnd, false);
});
