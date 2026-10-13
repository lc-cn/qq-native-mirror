import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Verify the actual installed declaration graph and package-root type interface.
 * @param {string} packageRoot
 * @param {string} compilerRoot
 * @param {string[]} typeRoots
 */
export async function verifyPublicContracts(packageRoot, compilerRoot, typeRoots) {
  /** @type {Promise<{default: typeof import('typescript')}>} */
  const compiler = import(pathToFileURL(join(compilerRoot, 'lib/typescript.js')).href);
  const { default: ts } = await compiler;
  /** @type {unknown} */
  const expected = JSON.parse(
    await readFile(new URL('../../test/fixtures/public-type-names.json', import.meta.url), 'utf8'),
  );
  assert.ok(Array.isArray(expected) && expected.every((name) => typeof name === 'string'));
  /** @type {import('typescript').CompilerOptions} */
  const options = {
    strict: true,
    noEmit: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    typeRoots,
    types: ['node'],
  };
  const dist = join(packageRoot, 'dist');
  /** @param {string} directory @returns {Promise<string[]>} */
  async function declarations(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
          ? declarations(path)
          : entry.name.endsWith('.d.ts')
            ? [path]
            : [];
      }),
    );
    return nested.flat();
  }
  const files = await declarations(dist);
  const inventory = new Set(files);
  for (const file of files) {
    const tree = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    /** @param {import('typescript').Node} node */
    function verify(node) {
      /** @type {import('typescript').Node | undefined} */
      let specifier;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        specifier = node.moduleSpecifier;
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
        specifier = node.argument.literal;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
        // TypeScript may retain .ts specifiers in declaration-only imports. Resolve
        // them with the consumer's compiler and require the actual packed .d.ts.
        const resolved = ts.resolveModuleName(specifier.text, file, options, ts.sys).resolvedModule;
        assert.ok(
          resolved && inventory.has(resolved.resolvedFileName),
          `Unpacked declaration dependency ${file} → ${specifier.text}`,
        );
      }
      ts.forEachChild(node, verify);
    }
    verify(tree);
  }
  const consumer = join(dirname(dirname(packageRoot)), 'public-contract-consumer.ts');
  await writeFile(
    consumer,
    `
import type { ${expected.join(', ')} } from 'qq-native-client';
export type CompatibilityTypes = [${expected.join(', ')}];
declare const peer: Peer;
if (peer.type === 'group') {
  const id: string = peer.groupId;
  void id;
  // @ts-expect-error Group peers do not carry a private recipient.
  peer.userId;
}
const login: LoginRequest = { method: 'quick', uin: '123' };
void login;
// @ts-expect-error Quick login requires an explicit account.
const invalidLogin: LoginRequest = { method: 'quick' };
// @ts-expect-error Received forward cards cannot be sent as raw message inputs.
const receivedAsSendable: SendableMessageElement = { type: 'forward', format: 'ark', resourceId: 'r' };
declare const liveMessage: ClientEvents['message'][0];
const typedMessageEvent: MessageEvent = liveMessage;
const replyFunction: MessageEvent['reply'] = typedMessageEvent.reply;
void replyFunction;
// @ts-expect-error Live reply capabilities cannot be reassigned by observers.
typedMessageEvent.reply = async () => ({ messageId: '1', sequence: '1', time: 0 });
const replyReceipt: Promise<SentMessage> = liveMessage.reply('pong', true);
void replyReceipt;
// @ts-expect-error Reply quoting is a boolean, not a string option.
liveMessage.reply('pong', 'quote');
declare const historicalMessage: Message;
// @ts-expect-error Historical message data does not own a live client reply capability.
historicalMessage.reply('pong');
declare const event: ClientEvents['request.group'][0];
const request: GroupRequest = event;
declare const receipt: SentMergedForward;
const sent: SentMessage = receipt;
declare const notices: GroupNoticePage;
const webNotices: WebGroupNoticeResult = notices;
declare const search: GroupSearchMatch;
const searchGroup: Group = search;
const ownerUid: string = search.ownerUid;
// @ts-expect-error Search snapshots do not invent a numeric owner account.
search.ownerUserId;
declare const client: import('qq-native-client').QQClient;
const searchResult: Promise<GroupSearchMatch | undefined> = client.searchGroup('123');
const folderResult: Promise<GroupFolder> = client.createGroupFolder('123', 'files');
const filePageResult: Promise<GroupFilePage> = client.getGroupFilePage('123', {startIndex: 0});
const fileListResult: Promise<GroupFileEntry[]> = client.listGroupFiles('123', {maxPages: 20});
// @ts-expect-error Full folder traversal always starts at zero.
client.listGroupFiles('123', {startIndex: 1});
// @ts-expect-error Page selectors are numeric, never unchecked strings.
client.getGroupFilePage('123', {sortType: '1'});
declare const fileMetadata: GroupFile;
const fileSize: string = fileMetadata.fileSize;
const parentFolder: string | null = fileMetadata.parentFolderId;
// @ts-expect-error uint64 native metadata must not lose precision through Number.
const roundedSize: number = fileMetadata.fileSize;
declare const fileEntry: GroupFileEntry;
// @ts-expect-error An opaque native kind cannot imply that file metadata exists.
fileEntry.fileInfo.fileId;
declare const folder: GroupFolder;
client.deleteGroupFolder(folder.groupId, folder.folderId);
// @ts-expect-error A folder snapshot does not claim a listing or file-count result.
folder.files;
void [request, sent, webNotices, searchGroup, ownerUid, searchResult, folderResult, filePageResult, fileListResult, fileSize, parentFolder];
`,
  );
  const program = ts.createProgram([consumer, join(dist, 'types.d.ts')], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    diagnostics.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'),
  );
  const compatibility = program.getSourceFile(join(dist, 'types.d.ts'));
  assert.ok(compatibility);
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(compatibility);
  assert.ok(symbol);
  const exports = checker.getExportsOfModule(symbol);
  assert.deepEqual(exports.map((symbol) => symbol.name).sort(), [...expected].sort());
  return { publicTypeExports: expected.length, installedDeclarationFiles: files.length };
}
