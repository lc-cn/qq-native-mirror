import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QQClient } from '../index.ts';
import type { Peer, HistoryOptions, MessageInput } from '../types.ts';
import { validateFaceId } from '../features/messages/face-input.ts';
import { normalizeMessageBatchQuery } from '../features/messages/query-input.ts';
import { captureMergedForward } from '../features/forward/merged-forward-input.ts';
import { normalizeForwardResourceId } from '../features/forward/forward-resource-wire.ts';

/** Checks command flags before configuration access or native client creation. */
export function validateCommandFlags(command: string, flags: Record<string, string>): void {
  const allowed: Record<string, string[]> = {
    init: [
      'config',
      'data-dir',
      'wrapper',
      'client-version',
      'app-id',
      'qua',
      'manifest',
      'manifest-sha256',
      'catalog',
      'download-mirror',
    ],
    config: ['config'],
    login: ['config', 'method', 'uin', 'qr-file'],
    members: ['config', 'uin', 'group-id'],
    history: ['config', 'uin', 'kind', 'target', 'limit', 'before'],
    message: ['config', 'uin', 'kind', 'target', 'message-id'],
    watch: ['config', 'uin', 'events'],
    contacts: ['config', 'uin'],
    'friend-categories': ['config', 'uin'],
    'friend-category-add': ['config', 'uin', 'name'],
    groups: ['config', 'uin'],
    send: ['config', 'kind', 'target', 'text', 'message-file', 'uin'],
    nickname: ['config', 'uin', 'name'],
    signature: ['config', 'uin', 'text'],
    profile: ['config', 'uin', 'target'],
    requests: ['config', 'uin'],
    request: ['config', 'uin', 'uid', 'time', 'accept'],
    'forward-history': ['config', 'uin', 'kind', 'target', 'root-message-id', 'parent-message-id'],
    forward: ['config', 'uin', 'source-kind', 'source-target', 'kind', 'target', 'message-ids'],
    messages: ['config', 'uin', 'kind', 'target', 'message-ids'],
    'forward-resource': ['config', 'uin', 'resource-id'],
    'send-forward': ['config', 'uin', 'kind', 'target', 'nodes-file', 'title', 'summary', 'prompt'],
    'group-requests': ['config', 'uin', 'doubt', 'limit', 'before'],
    'group-request': ['config', 'uin', 'group-id', 'sequence', 'type', 'accept', 'doubt', 'reason'],
    recall: ['config', 'uin', 'kind', 'target', 'message-id'],
    download: ['config', 'uin', 'kind', 'target', 'message-id', 'element-id', 'destination'],
    'friend-remark': ['config', 'uin', 'target', 'remark'],
    'friend-delete': ['config', 'uin', 'target', 'block', 'both'],
    'group-muted': ['config', 'uin', 'group-id'],
    'group-info': ['config', 'uin', 'group-id'],
    'group-name': ['config', 'uin', 'group-id', 'name'],
    'group-remark': ['config', 'uin', 'group-id', 'remark'],
    'group-mute': ['config', 'uin', 'group-id', 'enabled'],
    'member-mute': ['config', 'uin', 'group-id', 'user-id', 'seconds'],
    'member-card': ['config', 'uin', 'group-id', 'user-id', 'card'],
    'group-notices': ['config', 'uin', 'group-id'],
    'group-notice-publish': [
      'config',
      'uin',
      'group-id',
      'text',
      'image',
      'pinned',
      'confirm-required',
    ],
    'group-notice-delete': ['config', 'uin', 'group-id', 'notice-id'],
    'member-admin': ['config', 'uin', 'group-id', 'user-id', 'enabled'],
    'group-kick': ['config', 'uin', 'group-id', 'user-id', 'reject-rejoin', 'reason'],
    'group-leave': ['config', 'uin', 'group-id'],
  };
  if (!(command in allowed)) throw new Error(`Unknown command: ${command}`);
  for (const flag of Object.keys(flags))
    if (!allowed[command]!.includes(flag))
      throw new Error(`Unknown option for ${command}: --${flag}`);
}

export function parse(args: string[]) {
  const command = args.shift();
  const flags: Record<string, string> = {};
  while (args.length) {
    const flag = args.shift()!;
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`);
    if (flag === '--help') {
      flags.help = 'true';
      continue;
    }
    const value = args.shift();
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag.slice(2) in flags) throw new Error(`Duplicate option: ${flag}`);
    flags[flag.slice(2)] = value;
  }
  return { command, flags };
}
export function required(flags: Record<string, string>, key: string, allowEmpty = false) {
  if (flags[key] === undefined || (!allowEmpty && !flags[key]))
    throw new Error(`--${key} is required`);
  return flags[key];
}
export function numeric(flags: Record<string, string>, key: string): string {
  const value = required(flags, key);
  if (!/^\d+$/.test(value)) throw new Error(`--${key} must be a numeric string`);
  return value;
}
export function bool(flags: Record<string, string>, key: string, fallback?: boolean): boolean {
  if (flags[key] === undefined && fallback !== undefined) return fallback;
  const value = required(flags, key);
  if (value !== 'true' && value !== 'false') throw new Error(`--${key} must be true or false`);
  return value === 'true';
}
export function peer(flags: Record<string, string>): Peer {
  const kind = required(flags, 'kind');
  const target = numeric(flags, 'target');
  if (kind !== 'private' && kind !== 'group') throw new Error('--kind must be private or group');
  return kind === 'private'
    ? { type: 'private', userId: target }
    : { type: 'group', groupId: target };
}
export function normalizeMessage(value: unknown): MessageInput {
  if (typeof value === 'string') {
    if (!value.length) throw new Error('Message must not be empty');
    return value;
  }
  if (!Array.isArray(value) || !value.length)
    throw new Error('Message JSON must be a string or a nonempty element array');
  return value.map((element: unknown) => {
    if (!element || typeof element !== 'object' || Array.isArray(element))
      throw new Error('Invalid message element');
    const e = element as Record<string, unknown>;
    switch (e.type) {
      case 'text':
        if (typeof e.text !== 'string') throw new Error('text element requires text');
        return { type: 'text', text: e.text };
      case 'at':
        if (typeof e.userId !== 'string' || !(e.userId === 'all' || /^\d+$/.test(e.userId)))
          throw new Error('at requires numeric userId or all');
        if (e.text !== undefined && typeof e.text !== 'string')
          throw new Error('at text must be a string');
        return {
          type: 'at',
          userId: e.userId,
          ...(e.text !== undefined ? { text: e.text as string } : {}),
        };
      case 'face':
        validateFaceId(e.id);
        return { type: 'face', id: e.id };
      case 'video':
      case 'record':
        if (typeof e.file !== 'string' || !e.file)
          throw new Error(`${e.type} requires a local file path`);
        return { type: e.type, file: resolve(e.file) };
      case 'image':
      case 'file':
        if (typeof e.file !== 'string' || !e.file)
          throw new Error(`${e.type} requires a local file path`);
        if (e.type === 'file' && e.name !== undefined && typeof e.name !== 'string')
          throw new Error('file name must be a string');
        return e.type === 'image'
          ? { type: 'image', file: resolve(e.file) }
          : {
              type: 'file',
              file: resolve(e.file),
              ...(e.name !== undefined ? { name: e.name as string } : {}),
            };
      case 'reply':
        if (typeof e.messageId !== 'string' || !/^\d+$/.test(e.messageId))
          throw new Error('reply requires numeric messageId');
        return { type: 'reply', messageId: e.messageId };
      default:
        throw new Error(`Unsupported send element: ${String(e.type)}`);
    }
  });
}
/** Validates command payloads without loading native code; returned action is explicit. */
export async function prepareCommand(
  command: string,
  flags: Record<string, string>,
): Promise<(client: QQClient) => Promise<unknown>> {
  switch (command) {
    case 'contacts':
      return (client) => client.listFriends();
    case 'groups':
      return (client) => client.listGroups();
    case 'members': {
      const groupId = numeric(flags, 'group-id');
      return (client) => client.getGroupMembers(groupId);
    }
    case 'nickname': {
      const name = required(flags, 'name');
      if (!name.trim()) throw new Error('--name must not be blank');
      return (client) => client.setNickname(name);
    }
    case 'signature': {
      const text = required(flags, 'text', true);
      return (client) => client.setSignature(text);
    }
    case 'profile': {
      const target = numeric(flags, 'target');
      return (client) => client.getUserProfile(target);
    }
    case 'requests':
      return (client) => client.listFriendRequests();
    case 'forward-history': {
      const target = peer(flags),
        root = numeric(flags, 'root-message-id'),
        parent =
          flags['parent-message-id'] === undefined ? root : numeric(flags, 'parent-message-id');
      return (client) => client.getForwardMessages(target, root, parent);
    }
    case 'forward-resource': {
      const resourceId = normalizeForwardResourceId(required(flags, 'resource-id'));
      return (client) => client.getForwardResource(resourceId);
    }
    case 'forward': {
      const source = peer({
          kind: required(flags, 'source-kind'),
          target: required(flags, 'source-target'),
        }),
        destination = peer(flags);
      const ids = required(flags, 'message-ids').split(',');
      if (!ids.length || ids.some((id) => !/^\d+$/.test(id)))
        throw new Error('--message-ids must be comma-separated numeric IDs');
      return (client) => client.forwardMessages(source, destination, ids);
    }
    case 'send-forward': {
      const file = resolve(required(flags, 'nodes-file')),
        info = await stat(file);
      if (!info.isFile() || info.size > 2 * 1024 * 1024)
        throw Error('--nodes-file must be a regular JSON file of at most 2 MiB');
      const bytes = await readFile(file);
      if (bytes.length > 2 * 1024 * 1024) throw Error('--nodes-file exceeds 2 MiB');
      const options = Object.fromEntries(
        ['title', 'summary', 'prompt']
          .filter((key) => flags[key] !== undefined)
          .map((key) => [key, flags[key]]),
      );
      const input = captureMergedForward(
        peer(flags),
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        options,
      );
      return (client) => client.sendMergedForward(input.peer, input.nodes, input.options);
    }
    case 'group-requests': {
      const limit = flags.limit === undefined ? 20 : Number(numeric(flags, 'limit'));
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error('--limit must be an integer between 1 and 100');
      const options = {
        limit,
        doubt: bool(flags, 'doubt', false),
        ...(flags.before !== undefined ? { before: numeric(flags, 'before') } : {}),
      };
      return (client) => client.listGroupRequests(options);
    }
    case 'group-request': {
      const type = Number(numeric(flags, 'type'));
      if (type !== 1 && type !== 5 && type !== 7) throw new Error('--type must be 1, 5 or 7');
      const request: { groupId: string; sequence: string; type: 1 | 5 | 7; doubt: boolean } = {
        groupId: numeric(flags, 'group-id'),
        sequence: numeric(flags, 'sequence'),
        type,
        doubt: bool(flags, 'doubt', false),
      };
      const accept = bool(flags, 'accept');
      return (client) => client.handleGroupRequest(request, accept, flags.reason);
    }
    case 'request': {
      const request = { uid: required(flags, 'uid'), time: numeric(flags, 'time') };
      const accept = bool(flags, 'accept');
      return (client) => client.handleFriendRequest(request, accept);
    }
    case 'history': {
      const target = peer(flags);
      const options: HistoryOptions = {};
      if (flags.limit !== undefined) {
        const limit = Number(numeric(flags, 'limit'));
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new Error('--limit must be an integer between 1 and 100');
        options.limit = limit;
      }
      if (flags.before !== undefined) options.before = numeric(flags, 'before');
      return (client) => client.getHistory(target, options);
    }
    case 'message': {
      const target = peer(flags);
      const messageId = numeric(flags, 'message-id');
      return async (client) => (await client.getMessage(target, messageId)) ?? null;
    }
    case 'messages': {
      const query = normalizeMessageBatchQuery(
        peer(flags),
        required(flags, 'message-ids').split(','),
      );
      return async (client) =>
        (await client.getMessages(query.peer, query.messageIds)).map((message) => message ?? null);
    }
    case 'send': {
      const target = peer(flags);
      if ((flags.text !== undefined) === (flags['message-file'] !== undefined))
        throw new Error('Provide exactly one of --text or --message-file');
      const message = normalizeMessage(
        flags.text !== undefined
          ? flags.text
          : JSON.parse(await readFile(resolve(required(flags, 'message-file')), 'utf8')),
      );
      return (client) =>
        target.type === 'private'
          ? client.sendPrivateMessage(target.userId, message)
          : client.sendGroupMessage(target.groupId, message);
    }
    case 'recall': {
      const target = peer(flags);
      const messageId = numeric(flags, 'message-id');
      return (client) => client.recallMessage(target, messageId);
    }
    case 'download': {
      const target = peer(flags);
      const messageId = numeric(flags, 'message-id');
      const elementId = numeric(flags, 'element-id');
      const destination = resolve(required(flags, 'destination'));
      return (client) => client.downloadAttachment(target, messageId, elementId, destination);
    }
    case 'friend-remark': {
      const target = numeric(flags, 'target');
      const remark = required(flags, 'remark', true);
      return (client) => client.setFriendRemark(target, remark);
    }
    case 'group-muted': {
      const groupId = numeric(flags, 'group-id');
      return (client) => client.listGroupMutedMembers(groupId);
    }
    case 'group-info': {
      const groupId = numeric(flags, 'group-id');
      return (client) => client.getGroupInfo(groupId);
    }
    case 'friend-category-add': {
      const name = required(flags, 'name');
      if (!name.trim()) throw new Error('--name must not be blank');
      return (client) => client.addFriendCategory(name);
    }
    case 'friend-categories':
      return (client) => client.listFriendCategories();
    case 'friend-delete': {
      const target = numeric(flags, 'target');
      const options = { block: bool(flags, 'block', false), both: bool(flags, 'both', false) };
      return (client) => client.deleteFriend(target, options);
    }
    case 'group-name': {
      const group = numeric(flags, 'group-id');
      const name = required(flags, 'name');
      if (!name.trim()) throw new Error('--name must not be blank');
      return (client) => client.setGroupName(group, name);
    }
    case 'group-remark': {
      const group = numeric(flags, 'group-id');
      const remark = required(flags, 'remark', true);
      return (client) => client.setGroupRemark(group, remark);
    }
    case 'group-mute': {
      const group = numeric(flags, 'group-id');
      const enabled = bool(flags, 'enabled');
      return (client) => client.setGroupMute(group, enabled);
    }
    case 'member-mute': {
      const group = numeric(flags, 'group-id');
      const user = numeric(flags, 'user-id');
      const seconds = Number(numeric(flags, 'seconds'));
      if (!Number.isSafeInteger(seconds))
        throw new Error('--seconds must be a nonnegative safe integer');
      return (client) => client.setGroupMemberMute(group, user, seconds);
    }
    case 'member-card': {
      const group = numeric(flags, 'group-id');
      const user = numeric(flags, 'user-id');
      const card = required(flags, 'card', true);
      return (client) => client.setGroupMemberCard(group, user, card);
    }
    case 'member-admin': {
      const group = numeric(flags, 'group-id');
      const user = numeric(flags, 'user-id');
      const enabled = bool(flags, 'enabled');
      return (client) => client.setGroupAdmin(group, user, enabled);
    }
    case 'group-kick': {
      const group = numeric(flags, 'group-id');
      const user = numeric(flags, 'user-id');
      const options = {
        rejectRejoin: bool(flags, 'reject-rejoin', false),
        reason: flags.reason ?? '',
      };
      return (client) => client.kickGroupMember(group, user, options);
    }
    case 'group-notices': {
      const group = numeric(flags, 'group-id');
      return (client) => client.listGroupNotices(group);
    }
    case 'group-notice-publish': {
      const group = numeric(flags, 'group-id');
      const text = required(flags, 'text');
      if (!text.trim()) throw new Error('--text must not be blank');
      const options = {
        pinned: bool(flags, 'pinned', false),
        confirmRequired: bool(flags, 'confirm-required', false),
        ...(flags.image !== undefined ? { imagePath: resolve(required(flags, 'image')) } : {}),
      };
      return (client) => client.publishGroupNotice(group, text, options);
    }
    case 'group-notice-delete': {
      const group = numeric(flags, 'group-id');
      const noticeId = required(flags, 'notice-id');
      return (client) => client.deleteGroupNotice(group, noticeId);
    }
    case 'group-leave': {
      const group = numeric(flags, 'group-id');
      return (client) => client.leaveGroup(group);
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
