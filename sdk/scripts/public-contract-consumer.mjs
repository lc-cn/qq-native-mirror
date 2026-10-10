import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Verify the actual installed declaration graph and package-root type interface. */
export async function verifyPublicContracts(packageRoot, compilerRoot, typeRoots) {
  const { default: ts } = await import(pathToFileURL(join(compilerRoot, 'lib/typescript.js')).href);
  const expected = JSON.parse(
    await readFile(new URL('../test/fixtures/public-type-names.json', import.meta.url), 'utf8'),
  );
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
  async function declarations(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => {
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
    function verify(node) {
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
declare const folder: GroupFolder;
client.deleteGroupFolder(folder.groupId, folder.folderId);
// @ts-expect-error A folder snapshot does not claim a listing or file-count result.
folder.files;
void [request, sent, webNotices, searchGroup, ownerUid, searchResult, folderResult];
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
  const checker = program.getTypeChecker();
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(compatibility));
  assert.deepEqual(exports.map((symbol) => symbol.name).sort(), [...expected].sort());
  return { publicTypeExports: expected.length, installedDeclarationFiles: files.length };
}
