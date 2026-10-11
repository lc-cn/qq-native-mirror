import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { HistoryOptions, MessageInput } from '../../contracts/messages.ts';
import { validateFaceId } from '../../features/messages/face-input.ts';
import { normalizeMessageBatchQuery } from '../../features/messages/query-input.ts';
import { captureMergedForward } from '../../features/forward/merged-forward-input.ts';
import { normalizeForwardResourceId } from '../../features/forward/forward-resource-input.ts';
import { required, numeric, peer } from '../command-input.ts';
import type { ClientCommandDefinition } from '../command-contracts.ts';

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

/** Messages CLI plans use the public client and shared domain input rules. */
export const messagesCommands = {
  'forward-history': {
    flags: ['config', 'uin', 'kind', 'target', 'root-message-id', 'parent-message-id'],
    prepare(flags) {
      const target = peer(flags),
        root = numeric(flags, 'root-message-id'),
        parent =
          flags['parent-message-id'] === undefined ? root : numeric(flags, 'parent-message-id');
      return (client) => client.getForwardMessages(target, root, parent);
    },
  },
  'forward-resource': {
    flags: ['config', 'uin', 'resource-id'],
    prepare(flags) {
      const resourceId = normalizeForwardResourceId(required(flags, 'resource-id'));
      return (client) => client.getForwardResource(resourceId);
    },
  },
  forward: {
    flags: ['config', 'uin', 'source-kind', 'source-target', 'kind', 'target', 'message-ids'],
    prepare(flags) {
      const source = peer({
          kind: required(flags, 'source-kind'),
          target: required(flags, 'source-target'),
        }),
        destination = peer(flags);
      const ids = required(flags, 'message-ids').split(',');
      if (!ids.length || ids.some((id) => !/^\d+$/.test(id)))
        throw new Error('--message-ids must be comma-separated numeric IDs');
      return (client) => client.forwardMessages(source, destination, ids);
    },
  },
  'send-forward': {
    flags: ['config', 'uin', 'kind', 'target', 'nodes-file', 'title', 'summary', 'prompt'],
    async prepare(flags) {
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
    },
  },
  history: {
    flags: ['config', 'uin', 'kind', 'target', 'limit', 'before'],
    prepare(flags) {
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
    },
  },
  message: {
    flags: ['config', 'uin', 'kind', 'target', 'message-id'],
    async prepare(flags) {
      const target = peer(flags);
      const messageId = numeric(flags, 'message-id');
      return async (client) => (await client.getMessage(target, messageId)) ?? null;
    },
  },
  messages: {
    flags: ['config', 'uin', 'kind', 'target', 'message-ids'],
    async prepare(flags) {
      const query = normalizeMessageBatchQuery(
        peer(flags),
        required(flags, 'message-ids').split(','),
      );
      return async (client) =>
        (await client.getMessages(query.peer, query.messageIds)).map((message) => message ?? null);
    },
  },
  send: {
    flags: ['config', 'kind', 'target', 'text', 'message-file', 'uin'],
    async prepare(flags) {
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
    },
  },
  recall: {
    flags: ['config', 'uin', 'kind', 'target', 'message-id'],
    prepare(flags) {
      const target = peer(flags);
      const messageId = numeric(flags, 'message-id');
      return (client) => client.recallMessage(target, messageId);
    },
  },
  download: {
    flags: ['config', 'uin', 'kind', 'target', 'message-id', 'element-id', 'destination'],
    prepare(flags) {
      const target = peer(flags);
      const messageId = numeric(flags, 'message-id');
      const elementId = numeric(flags, 'element-id');
      const destination = resolve(required(flags, 'destination'));
      return (client) => client.downloadAttachment(target, messageId, elementId, destination);
    },
  },
} satisfies Record<string, ClientCommandDefinition>;
