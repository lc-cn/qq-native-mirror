#!/usr/bin/env node
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, type QQClient } from './index.ts';
import { validateDownloadMirrors } from './native-package.ts';
import { validateFaceId } from './message-elements.ts';
import { normalizeMessageBatchQuery } from './message-query.ts';
import {captureMergedForward} from './merged-forward.ts';
import {normalizeForwardResourceId} from './forward-resource-wire.ts';
import {KernelRequestError,MergedForwardError} from './errors.ts';
import type { ClientOptions, LoginRequest, Peer, HistoryOptions, MessageInput } from './types.ts';

function watchReconnectEnabled(value: ClientOptions['autoReconnect']): boolean {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid autoReconnect policy');
  const { maxAttempts = 3, delayMs = 1000 } = value;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !Number.isSafeInteger(delayMs) || delayMs < 0) throw new Error('Invalid autoReconnect policy');
  return true;
}

/** Watch only remains open across explicitly retryable, enabled reconnects. */
export function observeWatchFailures(client: QQClient, autoReconnect: ClientOptions['autoReconnect'], fail: (error: Error) => void): () => void {
  const enabled = watchReconnectEnabled(autoReconnect);
  const disconnected = (info: { retryable?: boolean } | undefined) => {
    if (!(enabled && info?.retryable === true)) fail(new Error('QQ watch stopped: account disconnected'));
  };
  const kicked = () => fail(new Error('QQ watch stopped: account kicked offline'));
  const logout = () => fail(new Error('QQ watch stopped: account logged out'));
  const failed = (error: Error) => fail(error);
  client.on('disconnected', disconnected); client.on('kicked', kicked); client.on('logout', logout);
  client.on('terminated', failed); client.on('reconnect-error', failed);
  return () => {
    client.off('disconnected', disconnected); client.off('kicked', kicked); client.off('logout', logout);
    client.off('terminated', failed); client.off('reconnect-error', failed);
  };
}

function watchEventMode(mode: unknown): 'message' | 'all' | 'normalized' {
  if (mode === undefined || mode === 'message') return 'message';
  if (mode === 'all') return 'all';
  if (mode === 'normalized') return 'normalized';
  throw new Error('--events must be message, all or normalized');
}
/** Attach business deliveries before login; return exact listener cleanup. */
export function observeWatchEvents(client: QQClient, mode: unknown = undefined, write: (line: string) => void = console.log): () => void {
  const selected = watchEventMode(mode);
  const events = selected === 'message' ? ['message'] as const : ['message', selected === 'normalized' ? 'message.recalled' : 'message-recalled', 'request.friend', 'request.group', 'friend-list-updated', 'group-list-updated', 'group-members-updated', 'group-info-updated', 'group-membership'] as const;
  const listeners = events.map(event => {
    const listener = (payload: unknown) => write(JSON.stringify(selected === 'message' ? payload : { event, payload }));
    client.on(event, listener);
    return { event, listener };
  });
  return () => { for (const { event, listener } of listeners) client.off(event, listener); };
}

const usage = `qq-native-client <command> [options]
  init --config FILE --data-dir DIR [--catalog URL] [--download-mirror HTTPS_PREFIX]
       [--wrapper FILE | --manifest URL --manifest-sha256 HASH]
       [--client-version V --app-id ID --qua Q]
  config --config FILE                 Check and display configuration
  login --config FILE [--method qr|restore|quick] [--uin UIN] [--qr-file FILE]
  contacts --config FILE [--uin UIN]    Restore login and list friends
  friend-categories --config FILE [--uin UIN]  List categorized friends
  groups --config FILE [--uin UIN]      Restore login and list groups
  members --config FILE --group-id ID [--uin UIN]
  history --config FILE --kind private|group --target ID [--limit 20] [--before MESSAGE_ID] [--uin UIN]
  message --config FILE --kind private|group --target ID --message-id ID
  messages --config FILE --kind private|group --target ID --message-ids ID,ID
  forward-history --config FILE --kind private|group --target ID --root-message-id ID [--parent-message-id ID]
  forward-resource --config FILE --resource-id ID [--uin UIN]
  forward --config FILE --source-kind private|group --source-target ID --kind private|group --target ID --message-ids ID,ID
  send-forward --config FILE --kind private|group --target ID --nodes-file FILE
       [--title TEXT --summary TEXT --prompt TEXT] [--uin UIN]
  watch --config FILE [--uin UIN] [--events message|all|normalized]  Print business events as JSON lines
  send --config FILE --kind private|group --target ID (--text TEXT | --message-file JSON) [--uin UIN]
  nickname --config FILE --name TEXT
  signature --config FILE --text TEXT   Empty text explicitly clears the signature
  profile --config FILE --target USER_ID
  requests --config FILE
  group-requests --config FILE [--doubt true|false] [--limit 20] [--before SEQUENCE]
  group-request --config FILE --group-id ID --sequence SEQUENCE --type 1|5|7 --accept true|false [--doubt true|false] [--reason TEXT]
  request --config FILE --uid UID --time SECONDS --accept true|false
  recall --config FILE --kind private|group --target ID --message-id ID
  download --config FILE --kind private|group --target ID --message-id ID --element-id ID --destination FILE
  friend-remark --config FILE --target USER_ID --remark TEXT
  friend-delete --config FILE --target USER_ID [--block true|false] [--both true|false]
  group-name --config FILE --group-id ID --name TEXT
  group-info --config FILE --group-id ID
  group-remark --config FILE --group-id ID --remark TEXT
  group-mute --config FILE --group-id ID --enabled true|false
  member-mute --config FILE --group-id ID --user-id ID --seconds SECONDS
  member-card --config FILE --group-id ID --user-id ID --card TEXT
  member-admin --config FILE --group-id ID --user-id ID --enabled true|false
  group-kick --config FILE --group-id ID --user-id ID [--reject-rejoin true|false] [--reason TEXT]
  group-notices --config FILE --group-id ID
  group-notice-publish --config FILE --group-id ID --text TEXT [--image FILE] [--pinned true|false] [--confirm-required true|false]
  group-notice-delete --config FILE --group-id ID --notice-id ID
  group-leave --config FILE --group-id ID
Account commands accept optional --uin UIN. Empty card/remark clears it.
Commands restore existing authorization unless login --method qr is explicit.
`;
export function parse(args: string[]) {
  const command = args.shift();
  const flags: Record<string, string> = {};
  while (args.length) {
    const flag = args.shift()!;
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`);
    if (flag === '--help') { flags.help = 'true'; continue; }
    const value = args.shift();
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag.slice(2) in flags) throw new Error(`Duplicate option: ${flag}`);
    flags[flag.slice(2)] = value;
  }
  return { command, flags };
}
function required(flags: Record<string, string>, key: string, allowEmpty = false) {
  if (flags[key] === undefined || (!allowEmpty && !flags[key])) throw new Error(`--${key} is required`);
  return flags[key];
}
function validateConfig(value: unknown): asserts value is ClientOptions {
  if (!value || typeof value !== 'object') throw new Error('Configuration must be a JSON object');
  const options = value as ClientOptions;
  if (!options.dataDir || typeof options.dataDir !== 'string') throw new Error('Configuration requires dataDir');
  if (options.wrapperPath && options.manifestUrl) throw new Error('Choose wrapperPath or manifestUrl');
  if (options.version && ![options.version.clientVersion, options.version.appId, options.version.qua].every(v => typeof v === 'string' && !!v)) throw new Error('Version requires complete metadata');
  if (options.catalogUrl) { const url=new URL(options.catalogUrl); if(url.protocol!=='https:'||url.username||url.password)throw new Error('Catalog requires HTTPS without credentials'); }
  validateDownloadMirrors(options.downloadMirrors);
  if (options.manifestUrl && !/^[a-f0-9]{64}$/i.test(options.manifestSha256 ?? '')) throw new Error('Mirror requires trusted manifestSha256');
}
function numeric(flags: Record<string, string>, key: string): string {
  const value = required(flags, key);
  if (!/^\d+$/.test(value)) throw new Error(`--${key} must be a numeric string`);
  return value;
}
function bool(flags: Record<string, string>, key: string, fallback?: boolean): boolean {
  if (flags[key] === undefined && fallback !== undefined) return fallback;
  const value = required(flags, key);
  if (value !== 'true' && value !== 'false') throw new Error(`--${key} must be true or false`);
  return value === 'true';
}
function peer(flags: Record<string, string>): Peer {
  const kind = required(flags, 'kind');
  const target = numeric(flags, 'target');
  if (kind !== 'private' && kind !== 'group') throw new Error('--kind must be private or group');
  return kind === 'private' ? { type: 'private', userId: target } : { type: 'group', groupId: target };
}
export function normalizeMessage(value: unknown): MessageInput {
  if (typeof value === 'string') { if (!value.length) throw new Error('Message must not be empty'); return value; }
  if (!Array.isArray(value) || !value.length) throw new Error('Message JSON must be a string or a nonempty element array');
  return value.map((element: unknown) => {
    if (!element || typeof element !== 'object' || Array.isArray(element)) throw new Error('Invalid message element');
    const e = element as Record<string, unknown>;
    switch (e.type) {
      case 'text': if (typeof e.text !== 'string') throw new Error('text element requires text'); return { type: 'text', text: e.text };
      case 'at': if (typeof e.userId !== 'string' || !(e.userId === 'all' || /^\d+$/.test(e.userId))) throw new Error('at requires numeric userId or all');
        if (e.text !== undefined && typeof e.text !== 'string') throw new Error('at text must be a string');
        return { type: 'at', userId: e.userId, ...(e.text !== undefined ? { text: e.text as string } : {}) };
      case 'face': validateFaceId(e.id); return { type: 'face', id: e.id };
      case 'video': case 'record': if (typeof e.file !== 'string' || !e.file) throw new Error(`${e.type} requires a local file path`); return { type: e.type, file: resolve(e.file) };
      case 'image': case 'file': if (typeof e.file !== 'string' || !e.file) throw new Error(`${e.type} requires a local file path`);
        if (e.type === 'file' && e.name !== undefined && typeof e.name !== 'string') throw new Error('file name must be a string');
        return e.type === 'image' ? { type: 'image', file: resolve(e.file) } : { type: 'file', file: resolve(e.file), ...(e.name !== undefined ? { name: e.name as string } : {}) };
      case 'reply': if (typeof e.messageId !== 'string' || !/^\d+$/.test(e.messageId)) throw new Error('reply requires numeric messageId'); return { type: 'reply', messageId: e.messageId };
      default: throw new Error(`Unsupported send element: ${String(e.type)}`);
    }
  });
}
/** Validates command payloads without loading native code; returned action is explicit. */
export async function prepareCommand(command: string, flags: Record<string, string>): Promise<(client: QQClient) => Promise<unknown>> {
  switch (command) {
    case 'contacts': return client => client.listFriends();
    case 'groups': return client => client.listGroups();
    case 'members': { const groupId = numeric(flags, 'group-id'); return client => client.getGroupMembers(groupId); }
    case 'nickname': { const name=required(flags,'name');if(!name.trim()) throw new Error('--name must not be blank');return client=>client.setNickname(name); }
    case 'signature': { const text=required(flags,'text',true);return client=>client.setSignature(text); }
    case 'profile': { const target = numeric(flags, 'target'); return client => client.getUserProfile(target); }
    case 'requests': return client => client.listFriendRequests();
    case 'forward-history': {
      const target = peer(flags), root = numeric(flags, 'root-message-id'), parent = flags['parent-message-id'] === undefined ? root : numeric(flags, 'parent-message-id');
      return client => client.getForwardMessages(target, root, parent);
    }
    case 'forward-resource': {
      const resourceId=normalizeForwardResourceId(required(flags,'resource-id'));
      return client=>client.getForwardResource(resourceId);
    }
    case 'forward': {
      const source = peer({ kind: required(flags, 'source-kind'), target: required(flags, 'source-target') }), destination = peer(flags);
      const ids = required(flags, 'message-ids').split(',');
      if (!ids.length || ids.some(id => !/^\d+$/.test(id))) throw new Error('--message-ids must be comma-separated numeric IDs');
      return client => client.forwardMessages(source, destination, ids);
    }
    case 'send-forward': {
      const file=resolve(required(flags,'nodes-file')),info=await stat(file);
      if(!info.isFile()||info.size>2*1024*1024)throw Error('--nodes-file must be a regular JSON file of at most 2 MiB');
      const bytes=await readFile(file);if(bytes.length>2*1024*1024)throw Error('--nodes-file exceeds 2 MiB');
      const options=Object.fromEntries(['title','summary','prompt'].filter(key=>flags[key]!==undefined).map(key=>[key,flags[key]]));
      const input=captureMergedForward(peer(flags),JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),options);
      return client=>client.sendMergedForward(input.peer,input.nodes,input.options);
    }
    case 'group-requests': {
      const limit = flags.limit === undefined ? 20 : Number(numeric(flags, 'limit'));
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be an integer between 1 and 100');
      const options = { limit, doubt: bool(flags, 'doubt', false), ...(flags.before !== undefined ? { before: numeric(flags, 'before') } : {}) };
      return client => client.listGroupRequests(options);
    }
    case 'group-request': {
      const type = Number(numeric(flags, 'type'));
      if (type !== 1 && type !== 5 && type !== 7) throw new Error('--type must be 1, 5 or 7');
      const request: { groupId: string; sequence: string; type: 1 | 5 | 7; doubt: boolean } = { groupId: numeric(flags, 'group-id'), sequence: numeric(flags, 'sequence'), type, doubt: bool(flags, 'doubt', false) };
      const accept = bool(flags, 'accept');
      return client => client.handleGroupRequest(request, accept, flags.reason);
    }
    case 'request': { const request = { uid: required(flags, 'uid'), time: numeric(flags, 'time') }; const accept = bool(flags, 'accept'); return client => client.handleFriendRequest(request, accept); }
    case 'history': {
      const target = peer(flags); const options: HistoryOptions = {};
      if (flags.limit !== undefined) { const limit = Number(numeric(flags, 'limit')); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be an integer between 1 and 100'); options.limit = limit; }
      if (flags.before !== undefined) options.before = numeric(flags, 'before');
      return client => client.getHistory(target, options);
    }
    case 'message': { const target = peer(flags); const messageId = numeric(flags, 'message-id'); return async client => (await client.getMessage(target, messageId)) ?? null; }
    case 'messages': {
      const query = normalizeMessageBatchQuery(peer(flags), required(flags, 'message-ids').split(','));
      return async client => (await client.getMessages(query.peer, query.messageIds)).map(message => message ?? null);
    }
    case 'send': {
      const target = peer(flags);
      if ((flags.text !== undefined) === (flags['message-file'] !== undefined)) throw new Error('Provide exactly one of --text or --message-file');
      const message = normalizeMessage(flags.text !== undefined ? flags.text : JSON.parse(await readFile(resolve(required(flags, 'message-file')), 'utf8')));
      return client => target.type === 'private' ? client.sendPrivateMessage(target.userId, message) : client.sendGroupMessage(target.groupId, message);
    }
    case 'recall': { const target = peer(flags); const messageId = numeric(flags, 'message-id'); return client => client.recallMessage(target, messageId); }
    case 'download': { const target = peer(flags); const messageId = numeric(flags, 'message-id'); const elementId = numeric(flags, 'element-id'); const destination = resolve(required(flags, 'destination')); return client => client.downloadAttachment(target, messageId, elementId, destination); }
    case 'friend-remark': { const target = numeric(flags, 'target'); const remark = required(flags, 'remark', true); return client => client.setFriendRemark(target, remark); }
    case 'group-info': { const groupId = numeric(flags, 'group-id'); return client => client.getGroupInfo(groupId); }
    case 'friend-categories': return client => client.listFriendCategories();
    case 'friend-delete': { const target = numeric(flags, 'target'); const options = { block: bool(flags, 'block', false), both: bool(flags, 'both', false) }; return client => client.deleteFriend(target, options); }
    case 'group-name': { const group = numeric(flags, 'group-id'); const name = required(flags, 'name'); if (!name.trim()) throw new Error('--name must not be blank'); return client => client.setGroupName(group, name); }
    case 'group-remark': { const group = numeric(flags, 'group-id'); const remark = required(flags, 'remark', true); return client => client.setGroupRemark(group, remark); }
    case 'group-mute': { const group = numeric(flags, 'group-id'); const enabled = bool(flags, 'enabled'); return client => client.setGroupMute(group, enabled); }
    case 'member-mute': { const group = numeric(flags, 'group-id'); const user = numeric(flags, 'user-id'); const seconds = Number(numeric(flags, 'seconds')); if (!Number.isSafeInteger(seconds)) throw new Error('--seconds must be a nonnegative safe integer'); return client => client.setGroupMemberMute(group, user, seconds); }
    case 'member-card': { const group = numeric(flags, 'group-id'); const user = numeric(flags, 'user-id'); const card = required(flags, 'card', true); return client => client.setGroupMemberCard(group, user, card); }
    case 'member-admin': { const group = numeric(flags, 'group-id'); const user = numeric(flags, 'user-id'); const enabled = bool(flags, 'enabled'); return client => client.setGroupAdmin(group, user, enabled); }
    case 'group-kick': { const group = numeric(flags, 'group-id'); const user = numeric(flags, 'user-id'); const options = { rejectRejoin: bool(flags, 'reject-rejoin', false), reason: flags.reason ?? '' }; return client => client.kickGroupMember(group, user, options); }
    case 'group-notices': { const group = numeric(flags, 'group-id'); return client => client.listGroupNotices(group); }
    case 'group-notice-publish': {
      const group = numeric(flags, 'group-id'); const text = required(flags, 'text');
      if (!text.trim()) throw new Error('--text must not be blank');
      const options = { pinned: bool(flags, 'pinned', false), confirmRequired: bool(flags, 'confirm-required', false), ...(flags.image !== undefined ? { imagePath: resolve(required(flags, 'image')) } : {}) };
      return client => client.publishGroupNotice(group, text, options);
    }
    case 'group-notice-delete': { const group = numeric(flags, 'group-id'); const noticeId = required(flags, 'notice-id'); return client => client.deleteGroupNotice(group, noticeId); }
    case 'group-leave': { const group = numeric(flags, 'group-id'); return client => client.leaveGroup(group); }
    default: throw new Error(`Unknown command: ${command}`);
  }
}

async function main() {
  const { command, flags } = parse(process.argv.slice(2));
  if (!command || command === '--help' || flags.help) { console.log(usage); return; }
  const allowed: Record<string, string[]> = {
    init: ['config', 'data-dir', 'wrapper', 'client-version', 'app-id', 'qua', 'manifest', 'manifest-sha256', 'catalog', 'download-mirror'],
    config: ['config'], login: ['config', 'method', 'uin', 'qr-file'],
    members: ['config', 'uin', 'group-id'], history: ['config', 'uin', 'kind', 'target', 'limit', 'before'], message: ['config', 'uin', 'kind', 'target', 'message-id'], watch: ['config', 'uin', 'events'],
    contacts: ['config', 'uin'], 'friend-categories': ['config', 'uin'], groups: ['config', 'uin'], send: ['config', 'kind', 'target', 'text', 'message-file', 'uin'],
    nickname: ['config','uin','name'], signature: ['config','uin','text'],
    profile: ['config', 'uin', 'target'], requests: ['config', 'uin'], request: ['config', 'uin', 'uid', 'time', 'accept'],
    'forward-history': ['config', 'uin', 'kind', 'target', 'root-message-id', 'parent-message-id'], forward: ['config', 'uin', 'source-kind', 'source-target', 'kind', 'target', 'message-ids'],
    messages: ['config', 'uin', 'kind', 'target', 'message-ids'],
    'forward-resource': ['config', 'uin', 'resource-id'],
    'send-forward': ['config', 'uin', 'kind', 'target', 'nodes-file', 'title', 'summary', 'prompt'],
    'group-requests': ['config', 'uin', 'doubt', 'limit', 'before'], 'group-request': ['config', 'uin', 'group-id', 'sequence', 'type', 'accept', 'doubt', 'reason'],
    recall: ['config', 'uin', 'kind', 'target', 'message-id'], download: ['config', 'uin', 'kind', 'target', 'message-id', 'element-id', 'destination'],
    'friend-remark': ['config', 'uin', 'target', 'remark'], 'friend-delete': ['config', 'uin', 'target', 'block', 'both'],
    'group-info': ['config', 'uin', 'group-id'],
    'group-name': ['config', 'uin', 'group-id', 'name'], 'group-remark': ['config', 'uin', 'group-id', 'remark'], 'group-mute': ['config', 'uin', 'group-id', 'enabled'],
    'member-mute': ['config', 'uin', 'group-id', 'user-id', 'seconds'], 'member-card': ['config', 'uin', 'group-id', 'user-id', 'card'],
    'group-notices': ['config', 'uin', 'group-id'],
    'group-notice-publish': ['config', 'uin', 'group-id', 'text', 'image', 'pinned', 'confirm-required'], 'group-notice-delete': ['config', 'uin', 'group-id', 'notice-id'],
    'member-admin': ['config', 'uin', 'group-id', 'user-id', 'enabled'], 'group-kick': ['config', 'uin', 'group-id', 'user-id', 'reject-rejoin', 'reason'], 'group-leave': ['config', 'uin', 'group-id'],
  };
  if (!(command in allowed)) throw new Error(`Unknown command: ${command}`);
  for (const flag of Object.keys(flags)) if (!allowed[command]!.includes(flag)) throw new Error(`Unknown option for ${command}: --${flag}`);
  const watchMode = command === 'watch' ? watchEventMode(flags.events) : undefined;
  const action = ['init', 'config', 'login', 'watch'].includes(command) ? undefined : await prepareCommand(command, flags);
  const configPath = resolve(required(flags, 'config'));
  if (command === 'init') {
    const options: ClientOptions = { dataDir: resolve(required(flags, 'data-dir')) };
    if (flags.wrapper) {
      options.wrapperPath = resolve(flags.wrapper);
    }
    if (['client-version','app-id','qua'].some(key=>flags[key]!==undefined)) {
      options.version = { clientVersion: required(flags, 'client-version'), appId: required(flags, 'app-id'), qua: required(flags, 'qua') };
    }
    if (flags.manifest) { options.manifestUrl = flags.manifest; options.manifestSha256 = required(flags, 'manifest-sha256'); }
    if(flags.catalog)options.catalogUrl=flags.catalog;
    if(flags['download-mirror'])options.downloadMirrors=[flags['download-mirror']];
    validateConfig(options);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(options, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Created ${configPath}`); return;
  }
  const options: unknown = JSON.parse(await readFile(configPath, 'utf8'));
  validateConfig(options);
  if (command === 'config') { console.log(JSON.stringify(options, null, 2)); return; }
  let login: LoginRequest = { method: 'restore', ...(flags.uin ? { uin: flags.uin } : {}) };
  if (command === 'login') {
    const method = flags.method ?? 'restore';
    if (method === 'qr') login = { method: 'qr' };
    else if (method === 'quick') login = { method: 'quick', uin: required(flags, 'uin') };
    else if (method !== 'restore') throw new Error('--method must be qr, restore or quick');
  }
  if (command === 'watch') watchReconnectEnabled(options.autoReconnect);
  const client = await createClient({ ...options, login: undefined });
  let qrWrite: Promise<void> = Promise.resolve();
  const qrPath = resolve(flags['qr-file'] ?? `${configPath}.qrcode.png`);
  client.on('qrcode', ({ image }) => {
    qrWrite = qrWrite.then(async () => {
      await writeFile(qrPath, image, { mode: 0o600 });
      console.error(`Scan the login QR image: ${qrPath}`);
    });
    void qrWrite.catch(error => console.error(`Cannot save QR image: ${error.message}`));
  });
  client.on('login-error', error => console.error(`Login: ${error.message}`));
  let endWatch: (() => void) | undefined;
  let failWatch: ((error: Error) => void) | undefined;
  const watchDone = command === 'watch' ? new Promise<void>((resolve, reject) => { endWatch = resolve; failWatch = reject; }) : undefined;
  // Register before login so native deliveries during readiness are retained.
  let removeWatchObservers: (() => void) | undefined;
  let removeWatchEvents: (() => void) | undefined;
  if (watchDone) {
    void watchDone.catch(() => {});
    removeWatchEvents = observeWatchEvents(client, watchMode);
    removeWatchObservers = observeWatchFailures(client, options.autoReconnect, error => failWatch?.(error));
  }
  const stop = () => { process.exitCode = 130; endWatch?.(); void client.close().catch(() => {}).finally(() => { process.exitCode = 130; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const account = await client.login(login);
    await qrWrite;
    if (command === 'login') console.log(JSON.stringify(account));
    else if (watchDone) await watchDone;
    else if (action) { const result = await action(client); console.log(JSON.stringify(result === undefined ? { dispatched: true } : result, null, 2)); }
  } finally {
    removeWatchEvents?.();
    removeWatchObservers?.();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await client.close();
  }
}
export function formatCliError(error:unknown):string {
  const progress=error instanceof MergedForwardError?{phase:error.phase,...error.progress}:error instanceof KernelRequestError?error.mergedForward:undefined;
  return progress?JSON.stringify({error:error instanceof Error?error.message:'Merged-forward failed',mergedForward:progress,...(typeof (error as KernelRequestError).code==='string'||typeof (error as KernelRequestError).code==='number'?{code:(error as KernelRequestError).code}:{})}):error instanceof Error?error.message:String(error);
}
let isCliEntry = false;
try { isCliEntry = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
catch { /* Imported modules and non-file argv entries do not execute the CLI. */ }
if (isCliEntry) void main().catch(error => { console.error(formatCliError(error)); if (process.exitCode !== 130) process.exitCode = 1; });
