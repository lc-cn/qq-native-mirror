import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Offline packaging check: never creates a QQ client or loads native binaries.
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = await mkdtemp(join(tmpdir(), 'qq-package-consumer-'));
const run = (command, args, cwd = destination) => execFileSync(command, args, {
  cwd, encoding: 'utf8', env: { ...process.env, npm_config_cache: join(root, '.local/npm-cache') },
});
run('npm', ['run', 'build'], root);
const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], root))[0];
const files = packed.files.map(file => file.path);
if (files.some(path => /(^|\/)(\.local|test|scripts|node_modules)(\/|$)|\.(db|db-wal|db-shm)$/.test(path))) throw new Error('Private or development files leaked into package');
for (const path of ['dist/index.js', 'dist/index.d.ts', 'dist/cli.js', 'native/registration-bridge.c']) {
  if (!files.includes(path)) throw new Error(`Missing package file ${path}`);
}
await writeFile(join(destination, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(destination, packed.filename), join(root, '.local/artifacts/silk-wasm-3.7.1.tgz')]);
await writeFile(join(destination, 'import.mjs'), `import {createClient, QQClient} from 'qq-native-client';\nif(typeof createClient !== 'function' || typeof QQClient !== 'function') throw new Error('Invalid exports');\n`);
run(process.execPath, ['import.mjs']);
await writeFile(join(destination, 'faces.mjs'), `import assert from 'node:assert/strict';
import {normalizeMessage, prepareCommand} from './node_modules/qq-native-client/dist/cli.js';
import {faceElement} from './node_modules/qq-native-client/dist/message-elements.js';
const mixed=[{type:'text',text:'hello'},{type:'face',id:14},{type:'face',id:333}];
assert.deepEqual(normalizeMessage(mixed),mixed);
assert.deepEqual(faceElement(428),{elementType:6,elementId:'',faceElement:{faceIndex:428,faceType:2,faceText:'/收到',sourceType:1,stickerType:0,packId:'0',stickerId:'0'}});
assert.throws(()=>normalizeMessage([{type:'face',id:99999}]),/Unsupported QQ face/);
const action=await prepareCommand('send',{kind:'group',target:'123','message-file':'faces.json'});
let received; await action({sendGroupMessage:async(...args)=>{received=args;}});
assert.deepEqual(received,['123',mixed]);
`);
await writeFile(join(destination, 'faces.json'), JSON.stringify([{type:'text',text:'hello'},{type:'face',id:14},{type:'face',id:333}]));
run(process.execPath, ['faces.mjs']);
const help = run(process.execPath, ['node_modules/qq-native-client/dist/cli.js', '--help']);
if (!help.includes('group-kick') || !help.includes('--message-file')) throw new Error('Installed CLI lacks commands');
const cliEntry='node_modules/qq-native-client/dist/cli.js';
run(process.execPath,[cliEntry,'init','--config','qq.json','--data-dir','account','--download-mirror','https://gh-proxy.com/']);
const configuration=JSON.parse(run(process.execPath,[cliEntry,'config','--config','qq.json']));
if(configuration.wrapperPath || configuration.version || configuration.downloadMirrors?.[0]!=='https://gh-proxy.com/')throw new Error('Installed CLI default catalog configuration failed');
await writeFile(join(destination, 'consumer.ts'), `import {createClient, type ClientOptions, type QQClient} from 'qq-native-client';
const options: ClientOptions = {dataDir:'/account',downloadMirrors:['https://gh-proxy.com/'],autoReconnect:false};
const factory: (options: ClientOptions) => Promise<QQClient> = createClient;
function subscribe(client: QQClient) {
 client.on('native-callback', diagnostic => diagnostic.argumentTypes.join(','));
 client.on('kicked', info => info.args.length);
 client.on('request.group', request => request.sequence);
 const page = client.listGroupRequests({doubt:false,limit:20});
 const publish: Promise<void> = client.publishGroupNotice('123','example',{pinned:true,confirmRequired:false});
 const remove: Promise<void> = client.deleteGroupNotice('123','notice_id');
 const notices = client.listGroupNotices('123');
 const nickname: Promise<void> = client.setNickname('example');
 void nickname;
 void notices.then(page=>page.notices.map(notice=>notice.noticeId));
 void publish; void remove;
 void page.then(value => value.requests.map(request => request.kind));
 return client.sendPrivateMessage('123', [{type:'text',text:'example'},{type:'face',id:14}]);
}
void factory; void options; void subscribe;
`);
run(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--types', 'node', '--module', 'NodeNext', '--target', 'ES2023', '--typeRoots', resolve(root, 'node_modules/@types'), 'consumer.ts']);
const receipt = { checkedAt: new Date().toISOString(), package: packed.name, version: packed.version,
  integrity: packed.integrity, fileCount: files.length, checks: { privateFilesExcluded:true, installedImport:true, cliHelp:true, cliDefaultConfig:true, faceContract:true, declarations:true },
  nativeExecuted:false, accountUsed:false };
await mkdir(join(root, '.local'), {recursive:true});
await writeFile(join(root, '.local/package-consumer-verification.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
