import { createHash } from 'node:crypto';
import { readFile, stat, mkdir, copyFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import type { MessageElement } from './types.ts';

type Native = Record<string, any>;
/** Contract: NapCatQQ native MsgService + OneBot file converter, fixed commit:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/api/file.ts#L62-L87
 * getRichMediaFilePathForGuild allocates a local staging path; sendMsg performs
 * the network transfer. No user input URL is fetched or source file deleted.
 */
function dimensions(data: Buffer): { width: number; height: number; gif: boolean } {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), gif: false };
  }
  if (data.length >= 10 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8), gif: true };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset] !== 0xff) throw new Error('Invalid JPEG marker');
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker! >= 0xd0 && marker! <= 0xd7)) continue;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) throw new Error('Invalid JPEG segment');
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker!)) {
        if (length < 8) throw new Error('Invalid JPEG dimensions');
        return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3), gif: false };
      }
      offset += length;
    }
  }
  throw new Error('Image format unsupported; use PNG, JPEG or GIF');
}
export async function createImageElement(file: string, msgService: Native): Promise<Native> {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Image requires an absolute local file path');
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw new Error('Image must be a nonempty local file');
  const data = await readFile(file);
  const image = dimensions(data);
  if (image.width < 1 || image.height < 1) throw new Error('Invalid image dimensions');
  const md5 = createHash('md5').update(data).digest('hex');
  if (typeof msgService.getRichMediaFilePathForGuild !== 'function') throw new Error('Native service is missing getRichMediaFilePathForGuild');
  const fileName = basename(file);
  const destination = await msgService.getRichMediaFilePathForGuild({
    md5HexStr: md5, fileName, elementType: 2, elementSubType: 0,
    thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: '',
  });
  if (typeof destination !== 'string' || !isAbsolute(destination)) throw new Error('Invalid native image staging path');
  if (destination !== file) { await mkdir(dirname(destination), { recursive: true }); await copyFile(file, destination); }
  return { elementType: 2, elementId: '', picElement: {
    md5HexStr: md5, fileSize: String(data.length), picWidth: image.width, picHeight: image.height,
    fileName, sourcePath: destination, original: true, picType: image.gif ? 2000 : 1000,
    picSubType: 0, fileUuid: '', fileSubId: '', thumbFileSize: 0, summary: '',
  } };
}
/** Ordinary file messages use uploadGroupFile=false in the upstream converter:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/api/file.ts#L38-L60
 * Passing the local path lets the native send pipeline upload the attachment.
 */
export async function createFileElement(file: string, name?: string): Promise<Native> {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('File requires an absolute local path');
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw new Error('File message requires a nonempty local file');
  if (name !== undefined && (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\'))) throw new Error('Attachment name must be a filename');
  return { elementType: 3, elementId: '', fileElement: { fileName: name ?? basename(file), folderId: '', filePath: file, fileSize: String(info.size) } };
}
export async function createReplyElement(messageId: string, peer: Native, msgService: Native): Promise<Native> {
  if (typeof messageId !== 'string' || !messageId) throw new Error('Reply requires messageId');
  if (typeof msgService.getMsgsByMsgId !== 'function') throw new Error('Native service is missing getMsgsByMsgId');
  const result = await msgService.getMsgsByMsgId(peer, [messageId]);
  const original = result?.msgList?.find((message: Native) => String(message.msgId) === messageId);
  if (!original) throw new Error('Referenced message was not found in the target conversation');
  for (const field of ['msgSeq', 'msgId', 'senderUin', 'clientSeq']) {
    if (original[field] === undefined || original[field] === null) throw new Error(`Referenced message is missing ${field}`);
  }
  return { elementType: 7, elementId: '', replyElement: {
    replayMsgSeq: original.msgSeq, replayMsgId: original.msgId,
    senderUin: original.senderUin, senderUinStr: original.senderUin,
    replyMsgClientSeq: original.clientSeq, _replyMsgPeer: { ...peer },
  } };
}

/** Decode only fields supported by the public contract; preserve every other
 * native element intact instead of silently dropping media or notifications. */
export function decodeElements(native: Native[]): MessageElement[] {
  return native.map(element => {
    const text = element.textElement;
    if (text) {
      if (text.atType === 1 || text.atType === 2) return { type: 'at', userId: text.atType === 1 ? 'all' : String(text.atUid), text: text.content };
      return { type: 'text', text: text.content };
    }
    if (element.replyElement?.replayMsgId) return { type: 'reply', messageId: String(element.replyElement.replayMsgId) };
    if (element.faceElement && Number.isInteger(element.faceElement.faceIndex)) return { type: 'face', id: element.faceElement.faceIndex };
    if (element.picElement) {
      const file = element.picElement.filePath || element.picElement.sourcePath;
      if (typeof file === 'string' && file) return { type: 'image', file };
    }
    for (const [field, type] of [['fileElement', 'file'], ['videoElement', 'video'], ['pttElement', 'record']] as const) {
      const media = element[field];
      if (media && typeof media.filePath === 'string' && media.filePath) {
        return { type, file: media.filePath, elementId: String(element.elementId ?? ''), ...(type === 'file' ? { name: media.fileName, size: media.fileSize } : {}) };
      }
    }
    return { type: 'unknown', nativeType: Number(element.elementType), data: element };
  });
}
