// eslint-disable-next-line no-control-regex -- Reject control characters in untrusted native identifiers.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Receive-only schema pinned to NapCatQQ 26d7533e message/message.ts and api/msg.ts.
 * No relationship cache refresh, identity query or operator supplementation. */
import { createHash } from 'node:crypto';
import type { GroupMembershipEvent, GroupAdminEvent, GroupMuteEvent } from '../../types.ts';
type Field = { number: number; wire: number; value: bigint | Buffer };
function fields(data: Buffer): Field[] {
  let at = 0;
  const result: Field[] = [];
  const variable = (): bigint => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (at >= data.length) throw new Error('truncated');
      const byte = data[at++];
      if (i === 9 && byte > 1) throw new Error('overflow');
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) {
        if (i && byte === 0) throw new Error('noncanonical');
        return value;
      }
    }
    throw new Error('overflow');
  };
  while (at < data.length) {
    if (result.length >= 4096) throw new Error('fields');
    const tag = variable();
    if (tag > 0xffffffffn || !(tag >> 3n)) throw new Error('tag');
    const number = Number(tag >> 3n),
      wire = Number(tag & 7n);
    let value: bigint | Buffer;
    if (wire === 0) value = variable();
    else if (wire === 2) {
      const size = variable();
      if (size > BigInt(data.length - at)) throw new Error('length');
      value = data.subarray(at, at + Number(size));
      at += Number(size);
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (at + size > data.length) throw new Error('fixed');
      value = data.subarray(at, at + size);
      at += size;
    } else throw new Error('wire');
    result.push({ number, wire, value });
  }
  return result;
}
function one(rows: Field[], number: number, wire: number, required = false): Field | undefined {
  const found = rows.filter((row) => row.number === number);
  if (found.length > 1 || (found[0] && found[0].wire !== wire) || (required && !found.length))
    throw new Error('field');
  return found[0];
}
function bytes(row: Field): Buffer {
  return row.value as Buffer;
}
function uint(row: Field): number {
  if (typeof row.value !== 'bigint' || row.value > 0xffffffffn) throw new Error('uint32');
  return Number(row.value);
}
function uid(row: Field): string {
  const data = bytes(row);
  if (!data.length || data.length > 4096) throw new Error('uid');
  const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  if (!value.trim() || CONTROL_CHARACTERS.test(value)) throw new Error('uid');
  return value;
}
function parse(data: Buffer): GroupMembershipEvent | GroupAdminEvent | undefined {
  const envelope = fields(data),
    header = fields(bytes(one(envelope, 2, 2, true)!));
  const type = uint(one(header, 1, 0, true)!);
  if (type !== 33 && type !== 34 && type !== 44) return;
  const body = fields(bytes(one(envelope, 3, 2, true)!));
  const change = fields(bytes(one(body, 2, 2, true)!));
  const group = uint(one(change, 1, 0, true)!);
  if (!group) throw new Error('group');
  if (type === 44) {
    const body = fields(bytes(one(change, 4, 2, true)!));
    const enable = one(body, 2, 2),
      disable = one(body, 1, 2);
    if (!!enable === !!disable) throw new Error('ambiguous admin');
    const inner = fields(bytes((enable ?? disable)!));
    const enabled = !!enable;
    const flag = one(change, 2, 0);
    if (flag) uint(flag);
    for (const row of [one(change, 3, 0), one(inner, 2, 0)])
      if (row && uint(row) > 1) throw new Error('admin flag');
    return { groupId: String(group), memberUid: uid(one(inner, 1, 2, true)!), enabled };
  }
  const code = uint(one(change, 4, 0, true)!);
  const member = one(change, 3, 2),
    operator = one(change, 5, 2);
  // Validate other known scalar/bytes fields without assigning unknown semantics.
  for (const n of [2, 6]) {
    const field = one(change, n, 0);
    if (field) uint(field);
  }
  one(change, 7, 2);
  const event: GroupMembershipEvent = {
    groupId: String(group),
    direction: type === 33 ? 'increase' : 'decrease',
    code,
    kind:
      type === 33
        ? code === 131
          ? 'invite'
          : 'unknown'
        : (({ 130: 'leave', 131: 'kick', 3: 'kick-me', 129: 'disband' } as const)[code as 130] ??
          'unknown'),
  };
  if (member) event.memberUid = uid(member);
  if (operator && bytes(operator).length) {
    const raw = bytes(operator);
    // Only explicit protobuf operator UID is projected. Ambiguous legacy text stays absent.
    if (type === 34 && (code === 3 || raw[0] === 0x0a)) {
      const outer = fields(raw),
        nested = one(outer, 1, 2);
      if (nested) {
        const value = one(fields(bytes(nested)), 1, 2);
        if (value) event.operatorUid = uid(value);
      }
    }
  }
  return event;
}
export function createGroupSystemEvents(emit: (event: string, payload: unknown) => void) {
  let closed = false;
  const seen = new Set<string>();
  return {
    onRecvSysMsg(value: unknown): void {
      if (closed) return;
      let event: GroupMembershipEvent | GroupAdminEvent | undefined, hash: string;
      try {
        if (!Array.isArray(value) || !value.length || value.length > 1024 * 1024)
          throw new Error('input');
        const data = Buffer.alloc(value.length);
        for (let i = 0; i < value.length; i++) {
          const item = Object.getOwnPropertyDescriptor(value, String(i));
          if (
            !item ||
            !('value' in item) ||
            !Number.isInteger(item.value) ||
            item.value < 0 ||
            item.value > 255
          )
            throw new Error('byte');
          data[i] = item.value;
        }
        event = parse(data);
        if (!event) return;
        hash = createHash('sha256').update(data).digest('hex');
      } catch {
        emit('diagnostic', { stage: 'invalid-native-group-system-message' });
        return;
      }
      if (seen.has(hash)) return;
      seen.add(hash);
      if (seen.size > 2048) seen.delete(seen.values().next().value!);
      emit('direction' in event ? 'group-membership' : 'group-admin', event);
    },
    hasMuteCandidate(value: unknown): boolean {
      if (closed) return false;
      const own = (v: unknown, key: string): unknown => {
        if (!v || typeof v !== 'object') return undefined;
        const d = Object.getOwnPropertyDescriptor(v, key);
        return d && 'value' in d ? d.value : undefined;
      };
      try {
        if (!Array.isArray(value) || value.length > 4096) return false;
        for (let i = 0; i < value.length; i++) {
          const row = own(value, String(i));
          if (own(row, 'chatType') !== 2 || own(row, 'msgType') !== 5) continue;
          const elements = own(row, 'elements');
          if (!Array.isArray(elements)) continue;
          const gray = own(own(elements, '0'), 'grayTipElement');
          if (own(gray, 'subElementType') === 4 && own(own(gray, 'groupElement'), 'type') === 8)
            return true;
        }
      } catch {
        return false;
      }
      return false;
    },
    onRecvMsg(value: unknown): void {
      if (closed) return;
      const batch: { hash: string; event: GroupMuteEvent }[] = [];
      const own = (v: unknown, key: string): unknown => {
        if (!v || typeof v !== 'object') return undefined;
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (d && !('value' in d)) throw new Error('accessor');
        return d?.value;
      };
      const string = (v: unknown, empty = false): string => {
        if (
          typeof v !== 'string' ||
          Buffer.byteLength(v) > 4096 ||
          (!empty && !v.trim()) ||
          CONTROL_CHARACTERS.test(v)
        )
          throw new Error('uid');
        // Fatal round-trip rejects unpaired JavaScript surrogates.
        if (new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(v)) !== v)
          throw new Error('utf8');
        return v;
      };
      try {
        if (!Array.isArray(value) || value.length > 4096) throw new Error('batch');
        for (let i = 0; i < value.length; i++) {
          const row = own(value, String(i));
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('message');
          if (own(row, 'chatType') !== 2 || own(row, 'msgType') !== 5) continue;
          const elements = own(row, 'elements');
          if (!Array.isArray(elements) || !elements.length) throw new Error('elements');
          const element = own(elements, '0');
          const gray = own(element, 'grayTipElement');
          if (!gray || own(gray, 'subElementType') !== 4) continue;
          const group = own(gray, 'groupElement');
          if (own(group, 'type') !== 8) continue;
          const shut = own(group, 'shutUp');
          if (!shut) throw new Error('shutup');
          const groupId = string(own(row, 'peerUid'));
          if (!/^[1-9]\d*$/.test(groupId)) throw new Error('group');
          const durationSeconds = string(own(shut, 'duration'));
          if (!/^(0|[1-9]\d*)$/.test(durationSeconds)) throw new Error('duration');
          const memberUid = string(own(own(shut, 'member'), 'uid'), true);
          const operatorUid = string(own(own(shut, 'admin'), 'uid'));
          const event: GroupMuteEvent = {
            groupId,
            scope: memberUid ? 'member' : 'all',
            durationSeconds,
            enabled: durationSeconds !== '0',
            operatorUid,
            ...(memberUid ? { memberUid } : {}),
          };
          const msgId = own(row, 'msgId');
          if (typeof msgId !== 'string' || msgId.length > 4096 || !/^\d+$/.test(msgId))
            throw new Error('msgid');
          const hash =
            'mute:' +
            createHash('sha256')
              .update(JSON.stringify([msgId, event]))
              .digest('hex');
          batch.push({ hash, event });
        }
      } catch {
        if (!closed) emit('diagnostic', { stage: 'invalid-native-group-mute-message' });
        return;
      }
      for (const { hash, event } of batch) {
        if (closed) return;
        if (seen.has(hash)) continue;
        seen.add(hash);
        if (seen.size > 2048) seen.delete(seen.values().next().value!);
        emit('group-mute', event);
      }
    },
    close(): void {
      closed = true;
      seen.clear();
    },
  };
}
