// Git smart HTTP: protocol v2 (ls-refs, fetch) and v0 (upload-pack,
// receive-pack), over the shared store.
//
// Wire format notes (from the suite's client):
// - v0 advertisement: `# service=...` pkt-line, flush, ref lines (the first
//   carries `\0<capabilities>`), flush. Empty repo: a `<ZERO>
//   capabilities^{}` line. Peeled annotated tags get a `^{}` line.
// - v2 advertisement: first pkt-line exactly `version 2`, then capability
//   lines, then flush. No `# service` line.
// - v2 ls-refs answers `<oid> <name>[ symref-target:<ref>][ peeled:<oid>]`;
//   unborn HEAD is `unborn HEAD symref-target:<ref>`.
// - v2 fetch answers sections (`acknowledgments`, `shallow-info`, `packfile`)
//   each closed by a delim packet, the response by a flush. A packfile
//   section with zero sideband packets is a protocol error, so when there
//   is nothing to send the section is omitted entirely.
// - v0 fetch answers NAK/ACK/shallow pkt-lines, then sideband-64k pack
//   packets, then flush.
// - receive-pack is v0 only: commands, flush, pack bytes; the report is
//   pkt-lines inside sideband band-1 packets, then flush.

import { readPack, writePack } from './pack.ts';
import {
  ZERO_OID,
  parseCommit,
  parseTag,
  type Repo,
  type Store,
} from './store.ts';

export const AGENT = 'forge/1.0';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktKind = 'data' | 'flush' | 'delim';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Parse pkt-lines from the start of `buf`; returns packets and the offset where parsing stopped. */
export function parsePktLines(buf: Buffer, start = 0): { packets: Pkt[]; next: number } {
  const packets: Pkt[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const lenText = buf.subarray(i, i + 4).toString('ascii');
    if (lenText === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (lenText === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    const len = parseInt(lenText, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, next: i };
}

/** Split a sideband payload stream into band-1 chunks (<= 65515 data bytes each). */
export function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < data.length; i += CHUNK) {
    const chunk = data.subarray(i, Math.min(data.length, i + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Advertisement
// ---------------------------------------------------------------------------

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

function repoRefLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const defaultRef = repo.defaultRef();
  const defaultTip = repo.refs.get(defaultRef);
  if (defaultTip !== undefined) {
    lines.push({ oid: defaultTip, name: 'HEAD', symrefTarget: defaultRef });
  }
  const names = repo.refNames();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') line.peeled = parseTag(obj.data).object;
    }
    lines.push(line);
  }
  return lines;
}

function uploadPackCapsV0(repo: Repo): string {
  return [
    'side-band-64k',
    'multi_ack',
    'thin-pack',
    'ofs-delta',
    'shallow',
    `symref=HEAD:${repo.defaultRef()}`,
    `agent=${AGENT}`,
  ].join(' ');
}

function receivePackCapsV0(repo: Repo): string {
  return [
    'report-status',
    'side-band-64k',
    'delete-refs',
    `symref=HEAD:${repo.defaultRef()}`,
    `agent=${AGENT}`,
  ].join(' ');
}

export function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const caps = service === 'git-upload-pack' ? uploadPackCapsV0(repo) : receivePackCapsV0(repo);
  const lines = repoRefLines(repo);
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      let text = `${line.oid} ${line.name}`;
      if (index === 0) text += `\0${caps}`;
      parts.push(pktLine(`${text}\n`));
      if (line.peeled !== undefined) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function advertisementV2(): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------

export function handleLsRefs(repo: Repo, argLines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of argLines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const lines = repoRefLines(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (lines.length === 0) {
    if (unborn && keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD symref-target:${repo.defaultRef()}\n`));
    }
  } else {
    for (const line of lines) {
      if (!keep(line.name)) continue;
      let text = `${line.oid} ${line.name}`;
      if (line.name === 'HEAD' && symrefs && line.symrefTarget) text += ` symref-target:${line.symrefTarget}`;
      if (peel && line.peeled !== undefined) text += ` peeled:${line.peeled}`;
      parts.push(pktLine(`${text}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Fetch (v2 and v0 share the object selection)
// ---------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowSet: Set<string>;
  depth?: number;
}

export function parseFetchV2(argLines: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallowSet: new Set<string>() };
  for (const line of argLines) {
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallowSet.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) req.depth = n;
    }
  }
  return req;
}

export function parseFetchV0(packets: Pkt[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallowSet: new Set<string>() };
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('want ')) {
      // The first want line may carry capabilities after the oid.
      const rest = line.slice(5).trim();
      req.wants.push(rest.split(' ')[0] as string);
    } else if (line.startsWith('shallow ')) req.shallowSet.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) req.depth = n;
    } else if (seenFlush && line.startsWith('have ')) req.haves.push(line.slice(5).trim());
  }
  return req;
}

function fetchResponseV2(repo: Repo, req: FetchRequest): Buffer {
  const { objects, shallow, unshallow } = repo.fetchClosure({
    wants: req.wants,
    haves: req.haves,
    shallowSet: req.shallowSet,
    depth: req.depth,
  });
  // Section order per protocol v2 (git 2.43's reader, fetch-pack.c):
  // - When the request carried `have` lines, git processes the
  //   acknowledgments section first: `ready` + delim when a pack follows,
  //   a bare NAK + flush when nothing follows.
  // - When the request carried no haves, git skips acknowledgments entirely
  //   and requires the packfile section next (after an optional
  //   shallow-info section). An acknowledgments section here is fatal.
  // The suite's client dispatches on section names, so both shapes are
  // accepted there too.
  const parts: Buffer[] = [];
  const shallowSection = (): void => {
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
  };
  const packSection = (): void => {
    // The real server ends the pack with a flush, not a delim: the sideband
    // demux consumes the pack up to the flush, and the flush is the
    // response end. A delim before the flush makes the demux eat the flush
    // and leaves the end check reading EOF.
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(writePack(objects)));
  };
  if (req.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (objects.size > 0) {
      parts.push(pktLine('ready\n'));
      parts.push(pktDelim());
      shallowSection();
      packSection();
      parts.push(pktFlush());
    } else {
      parts.push(pktLine('NAK\n'));
      parts.push(pktFlush());
    }
  } else {
    shallowSection();
    packSection();
    parts.push(pktFlush());
  }
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: Repo, req: FetchRequest): Buffer {
  const { objects, shallow, unshallow } = repo.fetchClosure({
    wants: req.wants,
    haves: req.haves,
    shallowSet: req.shallowSet,
    depth: req.depth,
  });
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (objects.size > 0) parts.push(...sidebandPackets(writePack(objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------

export interface PushReport {
  unpackOk: boolean;
  refs: { ref: string; ok: boolean; reason?: string }[];
}

export function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const { packets, next } = parsePktLines(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    const clean = (nul >= 0 ? line.slice(0, nul) : line).trim();
    const parts = clean.split(' ');
    if (parts.length < 3) return { status: 400, body: Buffer.from('malformed command\n', 'utf8') };
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  if (commands.length === 0) return { status: 400, body: Buffer.from('no commands\n', 'utf8') };
  // The pack bytes follow the flush, if any.
  const packBytes = body.subarray(next);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, {
        resolveBase: (oid) => repo.objects.get(oid),
      });
      for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    } catch {
      unpackOk = false;
    }
  }
  const report: PushReport = { unpackOk, refs: [] };
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (!unpackOk) {
      report.refs.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    if (cmd.oldOid !== ZERO_OID && current !== cmd.oldOid) {
      report.refs.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (cmd.oldOid === ZERO_OID && current !== undefined) {
      report.refs.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      repo.refs.delete(cmd.ref);
      report.refs.push({ ref: cmd.ref, ok: true });
      continue;
    }
    const newObj = repo.objects.get(cmd.newOid);
    if (!newObj) {
      report.refs.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (cmd.ref.startsWith('refs/heads/')) {
      if (newObj.type !== 'commit') {
        report.refs.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (current !== undefined && !repo.isAncestor(current, cmd.newOid)) {
        report.refs.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    report.refs.push({ ref: cmd.ref, ok: true });
  }
  const lines: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : 'error unpack failed'}\n`)];
  for (const ref of report.refs) {
    lines.push(pktLine(ref.ok ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason ?? 'failed'}\n`));
  }
  const reportBytes = Buffer.concat(lines);
  const out = Buffer.concat([...sidebandPackets(reportBytes), pktFlush()]);
  return { status: 200, body: out };
}

// ---------------------------------------------------------------------------
// Dispatcher used by the HTTP router
// ---------------------------------------------------------------------------

export type GitKind = 'info-refs-upload' | 'info-refs-receive' | 'upload-pack' | 'receive-pack';

export interface GitRequest {
  store: Store;
  owner: string;
  repoName: string;
  kind: GitKind;
  gitProtocolV2: boolean;
  body: Buffer;
}

function notFoundJson(): { status: number; contentType: string; body: Buffer } {
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
}

/** Handle one git smart-HTTP request; returns {status, contentType, body}. */
export function handleGit(req: GitRequest): { status: number; contentType: string; body: Buffer } {
  const repo = req.store.getRepo(req.owner, req.repoName);
  if (repo === undefined) return notFoundJson();
  if (req.kind === 'info-refs-upload' || req.kind === 'info-refs-receive') {
    const service = req.kind === 'info-refs-upload' ? 'git-upload-pack' : 'git-receive-pack';
    const body = req.gitProtocolV2 && service === 'git-upload-pack' ? advertisementV2() : advertisementV0(repo, service);
    return { status: 200, contentType: `application/x-${service}-advertisement`, body };
  }
  if (req.kind === 'upload-pack') {
    if (req.gitProtocolV2) {
      const { packets } = parsePktLines(req.body);
      const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').trim());
      const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length);
      if (command === 'ls-refs') {
        const args = lines.filter((line) => !line.startsWith('command=') && !line.startsWith('agent=') && !line.startsWith('object-format='));
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, args) };
      }
      if (command === 'fetch') {
        const args = lines.filter((line) => !line.startsWith('command=') && !line.startsWith('agent=') && !line.startsWith('object-format='));
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV2(repo, parseFetchV2(args)) };
      }
      return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'unknown command' }), 'utf8') };
    }
    const { packets } = parsePktLines(req.body);
    if (packets.length === 0) {
      return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed request' }), 'utf8') };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV0(repo, parseFetchV0(packets)) };
  }
  // receive-pack (v0 only).
  const result = handleReceivePack(repo, req.body);
  return { status: result.status, contentType: 'application/x-git-receive-pack-result', body: result.body };
}
