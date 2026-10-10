import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const consumer = `import type {ForwardResource, ForwardRecord, ForwardResourceElement, SendableMessageElement, MessageInput, Message} from 'qq-native-client';
const raw = Buffer.from([1]);
const uidOnly: ForwardResourceElement = {type:'at',text:'@u',uid:'u_test',raw};
const uinOnly: ForwardResourceElement = {type:'at',text:'@1',userId:'123',raw};
const both: ForwardResourceElement = {type:'at',text:'@u',userId:'123',uid:'u_test',raw};
const all: ForwardResourceElement = {type:'at',text:'@all',userId:'all',raw};
const text: Extract<ForwardResourceElement,{type:'text'}> = {type:'text',text:'text'};
const face: Extract<ForwardResourceElement,{type:'face'}> = {type:'face',id:1};
const compatibleText: SendableMessageElement = text;
const compatibleFace: SendableMessageElement = face;
const extended33: ForwardResourceElement = {type:'face',id:1,serviceType:33,raw};
const extended37: ForwardResourceElement = {type:'face',id:1,serviceType:37,businessType:2,raw};
const unknown: ForwardResourceElement = {type:'unknown',fieldNumbers:[99],raw};
const record: ForwardRecord = {sender:{uid:'u_test',userId:'123',nickname:'n'},time:1,elements:[uidOnly,uinOnly,both,all,text,face,extended33,extended37,unknown],raw};
const resource: ForwardResource = {resourceId:'r',records:[record],raw};
// @ts-expect-error Received UID-only mentions lack the required sendable UIN.
const notSendableAt: SendableMessageElement = uidOnly;
// @ts-expect-error Extended faces require original bytes.
const noRaw: ForwardResourceElement = {type:'face',id:1,serviceType:33};
// @ts-expect-error Extended face bytes require a supported service discriminator.
const noService: ForwardResourceElement = {type:'face',id:1,raw};
// @ts-expect-error Unsupported service discriminator.
const wrongService: ForwardResourceElement = {type:'face',id:1,serviceType:32,raw};
// @ts-expect-error Mention original bytes are required.
const noMentionRaw: ForwardResourceElement = {type:'at',text:'@u',uid:'u_test'};
// @ts-expect-error Resource records have no native message identity.
record.messageId;
// @ts-expect-error Resource records have no conversation identity.
record.peer;
// @ts-expect-error Resource records have no native sequence.
record.sequence;
// @ts-expect-error A resource record is not a native Message.
const nativeMessage: Message = record;
// @ts-expect-error A resource is not sendable message input.
const resourceInput: MessageInput = resource;
// @ts-expect-error Resource records are not sendable elements.
const recordsInput: MessageInput = resource.records;
// @ts-expect-error Received element unions include unsupported/UID-only elements.
const elementsInput: MessageInput = record.elements;
void [compatibleText,compatibleFace,resource];
`;

/** Compile only the actual package's public declaration entry; never import its runtime. */
export async function verifyForwardResourceTypes(packagePath, typescriptRoot, typeRoots) {
  if (
    !isAbsolute(packagePath) ||
    !isAbsolute(typescriptRoot) ||
    !Array.isArray(typeRoots) ||
    !typeRoots.length ||
    typeRoots.some((path) => typeof path !== 'string' || !isAbsolute(path))
  ) {
    throw new TypeError('Type contract requires absolute package, TypeScript and type-root paths');
  }
  const root = await realpath(packagePath);
  const metadataBytes = await readFile(join(root, 'package.json'));
  const metadata = JSON.parse(metadataBytes);
  const entry = metadata.exports?.['.']?.types;
  if (
    metadata.name !== 'qq-native-client' ||
    typeof entry !== 'string' ||
    !entry.startsWith('./')
  ) {
    throw new Error('Type contract requires qq-native-client public exports types entry');
  }
  const declaration = await realpath(join(root, entry));
  const local = relative(root, declaration);
  if (
    !local ||
    local === '..' ||
    local.startsWith(`..${sep}`) ||
    isAbsolute(local) ||
    !declaration.endsWith('.d.ts')
  ) {
    throw new Error('Public declaration entry escapes package or is not a declaration');
  }
  const cli = join(typescriptRoot, 'lib', 'tsc.js');
  await readFile(cli);
  const directory = await mkdtemp(join(tmpdir(), 'qq-forward-types-'));
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(directory, 'consumer.ts'), consumer);
    await writeFile(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ['node'],
          typeRoots,
          allowImportingTsExtensions: true,
          paths: { 'qq-native-client': [declaration] },
        },
        files: ['consumer.ts'],
      }),
    );
    try {
      await run(process.execPath, [cli, '--project', join(directory, 'tsconfig.json')], {
        cwd: directory,
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Keep the existing bounded diagnostic boundary without exposing arbitrary causes.
      throw new Error(
        `Forward resource public type contract failed: ${error.stdout || error.stderr || error.message}`,
      );
    }
    return {
      success: true,
      noEmit: true,
      runtimeImported: false,
      publicPackage: metadata.name,
      version: metadata.version,
      publicDeclaration: entry,
      packageJsonSha256: createHash('sha256').update(metadataBytes).digest('hex'),
      declarationSha256: createHash('sha256')
        .update(await readFile(declaration))
        .digest('hex'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
