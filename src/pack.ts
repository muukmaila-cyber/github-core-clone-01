// Packfile read/write (git pack v2), with OFS_DELTA / REF_DELTA resolution.
//
// The entry sends undelted packs; it must still *read* deltas, because a
// client may push a pack that contains them.
//
// Finding where one object's deflate stream ends: Node's inflateSync ignores
// trailing bytes and throws on a truncated stream, so "inflates to the
// declared size" is monotonic in the end offset — a binary search finds the
// smallest end that inflates correctly.

import { inflateSync, deflateSync } from 'node:zlib';
import { sha1, hashObject, type GitObject, type ObjectType } from './store.ts';

const TYPE_COMMIT = 1;
const TYPE_TREE = 2;
const TYPE_BLOB = 3;
const TYPE_TAG = 4;
const TYPE_OFS_DELTA = 6;
const TYPE_REF_DELTA = 7;

function typeName(code: number): ObjectType | null {
  if (code === TYPE_COMMIT) return 'commit';
  if (code === TYPE_TREE) return 'tree';
  if (code === TYPE_BLOB) return 'blob';
  if (code === TYPE_TAG) return 'tag';
  return null;
}

function typeCode(type: ObjectType): number {
  if (type === 'commit') return TYPE_COMMIT;
  if (type === 'tree') return TYPE_TREE;
  if (type === 'blob') return TYPE_BLOB;
  return TYPE_TAG;
}

/** Read a varint (MSB continuation, 7 bits per byte, little-endian groups). */
function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    const byte = buf[i] as number;
    value |= (byte & 0x7f) << shift;
    i += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, next: i };
}

/** Apply a git delta to a base object, returning the result. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const srcSize = readVarint(delta, offset);
  offset = srcSize.next;
  if (srcSize.value !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint(delta, offset);
  offset = targetSize.next;
  const parts: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if ((op & 0x01) !== 0) { copyOffset = delta[offset] as number; offset += 1; }
      if ((op & 0x02) !== 0) { copyOffset |= (delta[offset] as number) << 8; offset += 1; }
      if ((op & 0x04) !== 0) { copyOffset |= (delta[offset] as number) << 16; offset += 1; }
      if ((op & 0x08) !== 0) { copyOffset |= (delta[offset] as number) << 24; offset += 1; }
      if ((op & 0x10) !== 0) { copySize = delta[offset] as number; offset += 1; }
      if ((op & 0x20) !== 0) { copySize |= (delta[offset] as number) << 8; offset += 1; }
      if ((op & 0x40) !== 0) { copySize |= (delta[offset] as number) << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      total += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      total += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== targetSize.value) throw new Error('delta target size mismatch');
  return Buffer.concat(parts, total);
}

/** Inflate the object at `offset` (declared size `size`); return data + next offset. */
function inflateObject(buf: Buffer, offset: number, size: number, limit: number): { data: Buffer; next: number } {
  // Binary search the smallest end that inflates to exactly `size` bytes.
  let lo = offset + 1;
  let hi = limit;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buf.subarray(offset, mid));
      if (out.length === size) {
        found = mid;
        hi = mid - 1;
      } else {
        // Inflated but wrong size: the stream ended early (a shorter object
        // cannot grow by extending), or this slice is still truncated.
        // A successful inflate means the stream ended at or before mid;
        // if the size is wrong, the real stream must end later — but a
        // longer slice can only add trailing garbage, never change the
        // output. So a wrong-size success means our size is wrong: fail.
        throw new Error('inflated size mismatch');
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'inflated size mismatch') throw err;
      lo = mid + 1;
    }
  }
  if (found < 0) throw new Error('could not inflate pack object');
  return { data: inflateSync(buf.subarray(offset, found)), next: found };
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  deltaBaseOid?: string;
  deltaBaseOffset?: number;
}

/**
 * Parse a packfile into objects. `resolveBase` supplies objects the pack
 * references but does not contain (thin packs); by default a missing base
 * is an error.
 */
export function readPack(
  buf: Buffer,
  opts: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const limit = buf.length - 20; // the last 20 bytes are the trailer checksum
  const rawList: RawEntry[] = [];
  const rawByOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let n = 0; n < count; n += 1) {
    const entryOffset = offset;
    let byte = buf[offset] as number;
    offset += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let deltaBaseOid: string | undefined;
    let deltaBaseOffset: number | undefined;
    if (code === TYPE_OFS_DELTA) {
      byte = buf[offset] as number;
      offset += 1;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      deltaBaseOffset = entryOffset - baseOffset;
    } else if (code === TYPE_REF_DELTA) {
      deltaBaseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (typeName(code) === null) {
      throw new Error(`unknown pack object type ${code}`);
    }
    const inflated = inflateObject(buf, offset, size, limit);
    offset = inflated.next;
    const entry: RawEntry = { offset: entryOffset, typeCode: code, size, data: inflated.data, deltaBaseOid, deltaBaseOffset };
    rawList.push(entry);
    rawByOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, GitObject>();
  const resolving = new Set<number>();
  const resolveEntry = (entry: RawEntry): GitObject => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let result: GitObject;
    if (entry.typeCode === TYPE_OFS_DELTA || entry.typeCode === TYPE_REF_DELTA) {
      let base: GitObject | undefined;
      if (entry.deltaBaseOffset !== undefined) {
        const baseEntry = rawByOffset.get(entry.deltaBaseOffset);
        if (!baseEntry) throw new Error('OFS_DELTA base not in pack');
        base = resolveEntry(baseEntry);
      } else if (entry.deltaBaseOid !== undefined) {
        base = objects.get(entry.deltaBaseOid) ?? opts.resolveBase?.(entry.deltaBaseOid);
        if (!base) {
          // The base may be another entry of this pack, not yet resolved:
          // find it by resolving every non-delta entry first, then retry.
          for (const candidate of rawList) {
            if (candidate.typeCode !== TYPE_OFS_DELTA && candidate.typeCode !== TYPE_REF_DELTA) {
              const got = resolveEntry(candidate);
              void got;
            }
          }
          base = objects.get(entry.deltaBaseOid) ?? opts.resolveBase?.(entry.deltaBaseOid);
        }
        if (!base) throw new Error(`REF_DELTA base ${entry.deltaBaseOid} not found`);
      } else {
        throw new Error('delta without a base');
      }
      const data = applyDelta(base.data, entry.data);
      result = { type: base.type, data };
    } else {
      const type = typeName(entry.typeCode);
      if (type === null) throw new Error(`unknown pack object type ${entry.typeCode}`);
      result = { type, data: entry.data };
    }
    resolving.delete(entry.offset);
    resolved.set(entry.offset, result);
    const oid = hashObject(result.type, result.data);
    objects.set(oid, result);
    return result;
  };
  for (const entry of rawList) resolveEntry(entry);
  return objects;
}

/** The trailer checksum of a packfile: sha1 of everything before the last 20 bytes. */
export function verifyPackChecksum(buf: Buffer): boolean {
  if (buf.length < 20) return false;
  const expected = buf.subarray(buf.length - 20).toString('hex');
  return sha1(buf.subarray(0, buf.length - 20)) === expected;
}

/** Build a packfile (version 2, undelted entries) from objects. */
export function writePack(objects: Map<string, GitObject> | GitObject[]): Buffer {
  const list = Array.isArray(objects) ? objects : [...objects.values()];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    const code = typeCode(obj.type);
    const size = obj.data.length;
    // Type+size varint: first byte holds 4 size bits, continuation adds 7.
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (code << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1(body), 'hex');
  return Buffer.concat([body, trailer]);
}
