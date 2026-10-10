/** Receive-only schema pinned to NapCatQQ 26d7533e message/message.ts and api/msg.ts.
 * No relationship cache refresh, identity query or operator supplementation. */
import { createHash } from 'node:crypto';
import type { GroupMembershipEvent } from './types.ts';
type Field = { number: number; wire: number; value: bigint | Buffer };
function fields(data: Buffer): Field[] {
  let at = 0; const result: Field[] = [];
  const variable = (): bigint => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (at >= data.length) throw new Error('truncated');
      const byte = data[at++];
      if (i === 9 && byte > 1) throw new Error('overflow');
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) { if (i && byte === 0) throw new Error('noncanonical'); return value; }
    }
    throw new Error('overflow');
  };
  while (at < data.length) {
    if (result.length >= 4096) throw new Error('fields');
    const tag = variable(); if (tag > 0xffffffffn || !(tag >> 3n)) throw new Error('tag');
    const number = Number(tag >> 3n), wire = Number(tag & 7n); let value: bigint | Buffer;
    if (wire === 0) value = variable();
    else if (wire === 2) { const size = variable(); if (size > BigInt(data.length - at)) throw new Error('length'); value = data.subarray(at, at + Number(size)); at += Number(size); }
    else if (wire === 1 || wire === 5) { const size = wire === 1 ? 8 : 4; if (at + size > data.length) throw new Error('fixed'); value = data.subarray(at, at + size); at += size; }
    else throw new Error('wire');
    result.push({ number, wire, value });
  }
  return result;
}
function one(rows: Field[], number: number, wire: number, required = false): Field | undefined {
  const found = rows.filter(row => row.number === number);
  if (found.length > 1 || (found[0] && found[0].wire !== wire) || (required && !found.length)) throw new Error('field');
  return found[0];
}
function bytes(row: Field): Buffer { return row.value as Buffer; }
function uint(row: Field): number { if (typeof row.value !== 'bigint' || row.value > 0xffffffffn) throw new Error('uint32'); return Number(row.value); }
function uid(row: Field): string { const data = bytes(row); if (!data.length || data.length > 4096) throw new Error('uid'); const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); if (!value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('uid'); return value; }
function parse(data: Buffer): GroupMembershipEvent | undefined {
  const envelope = fields(data), header = fields(bytes(one(envelope, 2, 2, true)!));
  const type = uint(one(header, 1, 0, true)!);
  if (type !== 33 && type !== 34) return;
  const body = fields(bytes(one(envelope, 3, 2, true)!));
  const change = fields(bytes(one(body, 2, 2, true)!));
  const group = uint(one(change, 1, 0, true)!); if (!group) throw new Error('group');
  const code = uint(one(change, 4, 0, true)!);
  const member = one(change, 3, 2), operator = one(change, 5, 2);
  // Validate other known scalar/bytes fields without assigning unknown semantics.
  for (const n of [2, 6]) { const field = one(change, n, 0); if (field) uint(field); }
  one(change, 7, 2);
  const event: GroupMembershipEvent = { groupId: String(group), direction: type === 33 ? 'increase' : 'decrease', code,
    kind: type === 33 ? (code === 131 ? 'invite' : 'unknown') : ({ 130: 'leave', 131: 'kick', 3: 'kick-me', 129: 'disband' } as const)[code as 130] ?? 'unknown' };
  if (member) event.memberUid = uid(member);
  if (operator && bytes(operator).length) {
    const raw = bytes(operator);
    // Only explicit protobuf operator UID is projected. Ambiguous legacy text stays absent.
    if (type === 34 && (code === 3 || raw[0] === 0x0a)) {
      const outer = fields(raw), nested = one(outer, 1, 2);
      if (nested) { const value = one(fields(bytes(nested)), 1, 2); if (value) event.operatorUid = uid(value); }
    }
  }
  return event;
}
export function createGroupSystemEvents(emit: (event: string, payload: unknown) => void) {
  let closed = false; const seen = new Set<string>();
  return {
    onRecvSysMsg(value: unknown): void {
      if (closed) return;
      let event: GroupMembershipEvent | undefined, hash: string;
      try {
        if (!Array.isArray(value) || !value.length || value.length > 1024 * 1024) throw new Error('input');
        const data = Buffer.alloc(value.length);
        for (let i = 0; i < value.length; i++) { const item = Object.getOwnPropertyDescriptor(value, String(i)); if (!item || !('value' in item) || !Number.isInteger(item.value) || item.value < 0 || item.value > 255) throw new Error('byte'); data[i] = item.value; }
        event = parse(data); if (!event) return;
        hash = createHash('sha256').update(data).digest('hex');
      } catch { emit('diagnostic', { stage: 'invalid-native-group-system-message' }); return; }
      if (seen.has(hash)) return;
      seen.add(hash); if (seen.size > 2048) seen.delete(seen.values().next().value!);
      emit('group-membership', event);
    },
    close(): void { closed = true; seen.clear(); },
  };
}
