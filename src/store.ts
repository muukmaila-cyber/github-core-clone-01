// The single store every surface reads and writes: git objects and refs,
// repositories, issues, pull requests, comments and labels.
//
// Determinism: nothing here reads a wall clock or Math.random. Timestamps
// come from a logical clock seeded from MAKEFUN_TRIAL_NOW (or a fixed epoch),
// advanced one second per mutation. Ids are sequential counters. Given the
// same request order, the store reaches the same state byte for byte.

import { createHash } from 'node:crypto';
import type { ScenarioUser } from './scenario.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

// ---------------------------------------------------------------------------
// Git object encoding
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git tree ordering: directory names compare with a trailing '/'. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(i, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// Logical clock
// ---------------------------------------------------------------------------

export class Clock {
  #epochSec: number;

  constructor() {
    const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = raw === '' ? NaN : Date.parse(raw) / 1000;
    this.#epochSec = Number.isFinite(parsed) ? Math.trunc(parsed) : 1794940800; // 2026-11-20T00:00:00Z
  }

  /** Advance one second and return the new time as an ISO string. */
  tick(): string {
    this.#epochSec += 1;
    return new Date(this.#epochSec * 1000).toISOString();
  }

  /** The current epoch seconds, without advancing. */
  epochSec(): number {
    return this.#epochSec;
  }
}

// ---------------------------------------------------------------------------
// Issues, pull requests, repositories
// ---------------------------------------------------------------------------

export interface IssueLabel {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: IssueLabel[];
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
  comments: { id: number; body: string; createdAt: string }[];
  /** Cached GET /issues/{n} body; cleared on any mutation of the issue. */
  cachedJson: Buffer | null;
}

export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  /** The base tip at creation: the merge-base for conflict detection. */
  baseTip: string;
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch = 'main';
  createdAt: string;
  updatedAt: string;
  /** refs/heads/*, refs/tags/* -> tip oid */
  refs = new Map<string, string>();
  objects = new Map<string, GitObject>();
  issues: Issue[] = [];
  pulls: PullRequest[] = [];
  labels = new Map<string, IssueLabel>();
  nextNumber = 1;
  nextCommentId = 1;
  nextIssueId: number;
  seq = 0;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, createdAt: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.private = isPrivate;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
    this.nextIssueId = id * 100000;
    for (const label of ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']) {
      this.labels.set(label, { name: label, color: '000000' });
    }
  }

  fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  defaultRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  defaultTip(): string | undefined {
    return this.refs.get(this.defaultRef());
  }

  /** All refs, HEAD first is the caller's job. */
  refNames(): string[] {
    return [...this.refs.keys()].sort();
  }

  branches(): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of this.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  findIssue(number: number): Issue | undefined {
    return this.issues.find((issue) => issue.number === number);
  }

  findPull(number: number): PullRequest | undefined {
    return this.pulls.find((pull) => pull.number === number);
  }

  /** A commit's tree, flattened to path -> {oid, mode}. */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** The tree oid of a commit oid, or null. */
  commitTree(commitOid: string): string | null {
    const obj = this.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  /** Whether `ancestor` is reachable from `descendant` (inclusive). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return false;
  }

  /**
   * The object set a fetch must send: the depth-limited closure of `wants`
   * (commits via parents, plus each sent commit's full tree/blob closure;
   * tag wants peel to their target commit), minus everything the client
   * already holds (the closure of `haves`, which never traverses past a
   * commit in `shallowSet` — the client does not hold those parents).
   *
   * A want that the client already holds is still walked: with a `deepen`
   * the client asks for history *below* that shallow boundary, so the walk
   * descends from a held want but stops at any other held commit.
   */
  fetchClosure(opts: {
    wants: string[];
    haves?: string[];
    shallowSet?: Set<string>;
    depth?: number;
  }): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
    const { wants, haves = [], shallowSet = new Set<string>(), depth } = opts;
    const send = new Map<string, GitObject>();
    const shallowOut: string[] = [];
    // Held commits: the closure of haves, not traversing past shallowSet.
    const held = new Set<string>();
    {
      const stack = [...haves];
      while (stack.length > 0) {
        const oid = stack.pop() as string;
        if (held.has(oid)) continue;
        held.add(oid);
        if (shallowSet.has(oid)) continue;
        const obj = this.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        for (const parent of parseCommit(obj.data).parents) stack.push(parent);
      }
    }
    // Objects the client already owns (held commits + their tree closures).
    const owned = new Set<string>();
    {
      const stack = [...haves];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const oid = stack.pop() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        if (shallowSet.has(oid)) {
          owned.add(oid);
          continue;
        }
        const obj = this.objects.get(oid);
        if (!obj) continue;
        owned.add(oid);
        if (obj.type === 'commit') {
          const commit = parseCommit(obj.data);
          const trees = [commit.tree];
          while (trees.length > 0) {
            const treeOid = trees.pop() as string;
            if (owned.has(treeOid)) continue;
            const treeObj = this.objects.get(treeOid);
            if (!treeObj) continue;
            owned.add(treeOid);
            for (const entry of parseTree(treeObj.data)) {
              if (entry.mode === '40000') trees.push(entry.oid);
              else owned.add(entry.oid);
            }
          }
          for (const parent of commit.parents) stack.push(parent);
        } else if (obj.type === 'tag') {
          stack.push(parseTag(obj.data).object);
        }
      }
    }
    // Walk wants, depth-limited.
    const roots = new Set<string>();
    const queue: { oid: string; depthLeft: number }[] = [];
    for (const want of wants) {
      const obj = this.objects.get(want);
      if (!obj) continue;
      if (obj.type === 'tag') {
        if (!owned.has(want)) send.set(want, obj);
        roots.add(parseTag(obj.data).object);
        queue.push({ oid: parseTag(obj.data).object, depthLeft: depth ?? Infinity });
      } else if (obj.type === 'commit') {
        roots.add(want);
        queue.push({ oid: want, depthLeft: depth ?? Infinity });
      } else if (!owned.has(want)) {
        send.set(want, obj);
      }
    }
    const visited = new Set<string>();
    const addTreeClosure = (treeOid: string): void => {
      const treeStack = [treeOid];
      while (treeStack.length > 0) {
        const current = treeStack.pop() as string;
        if (send.has(current)) continue;
        const treeObj = this.objects.get(current);
        if (!treeObj) continue;
        send.set(current, treeObj);
        for (const entry of parseTree(treeObj.data)) {
          if (entry.mode === '40000') treeStack.push(entry.oid);
          else if (!send.has(entry.oid)) {
            const blob = this.objects.get(entry.oid);
            if (blob) send.set(entry.oid, blob);
          }
        }
      }
    };
    while (queue.length > 0) {
      const { oid, depthLeft } = queue.shift() as { oid: string; depthLeft: number };
      if (visited.has(oid)) continue;
      visited.add(oid);
      const isRoot = roots.has(oid);
      const isHeld = held.has(oid);
      const isShallowBoundary = shallowSet.has(oid);
      // A held commit that is neither a want nor a shallow boundary: the
      // client holds it and everything below it. Stop here.
      if (isHeld && !isRoot && !isShallowBoundary) continue;
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (!isHeld) {
        send.set(oid, obj);
        addTreeClosure(parseCommit(obj.data).tree);
      }
      if (depth !== undefined && depthLeft <= 1) {
        if (!isHeld) shallowOut.push(oid);
        continue;
      }
      for (const parent of parseCommit(obj.data).parents) {
        if (!visited.has(parent)) queue.push({ oid: parent, depthLeft: depthLeft - 1 });
      }
    }
    // Never re-send objects the client already owns (shared blobs/trees
    // under a held commit stay in the client's store).
    for (const oid of owned) send.delete(oid);
    // A shallow boundary the walk passed below is no longer shallow.
    const unshallowOut = [...shallowSet].filter((oid) => visited.has(oid) && !shallowOut.includes(oid));
    return { objects: send, shallow: shallowOut, unshallow: unshallowOut };
  }

  /** Paths changed between two trees (path -> blob oid, null = deleted). */
  diffTrees(baseTree: string | null, headTree: string | null): Map<string, string | null> {
    const base = baseTree === null ? new Map() : this.flattenTree(baseTree);
    const head = headTree === null ? new Map() : this.flattenTree(headTree);
    const out = new Map<string, string | null>();
    for (const [path, entry] of head) {
      if (!base.has(path) || base.get(path)?.oid !== entry.oid) out.set(path, entry.oid);
    }
    for (const path of base.keys()) {
      if (!head.has(path)) out.set(path, null);
    }
    return out;
  }
}

export class Store {
  viewer: ScenarioUser;
  clock = new Clock();
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  requestSeq = 0;
  /**
   * Cache of fetch results: pack bytes + shallow/unshallow lists, keyed by
   * the exact fetch parameters. A fetch result is a pure function of the
   * objects it closes over, and objects are append-only (a ref update never
   * removes the objects a previous fetch sent), so an entry stays valid
   * for the life of the process. Bounded, FIFO eviction.
   */
  fetchPackCache = new Map<string, { pack: Buffer; count: number; shallow: string[]; unshallow: string[] }>();

  constructor(viewer: ScenarioUser) {
    this.viewer = viewer;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const now = this.clock.tick();
    const repo = new Repo(this.nextRepoId, owner, name, description, isPrivate, now);
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Repos owned by the viewer, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === this.viewer.login);
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `GH-${this.requestSeq.toString(16).padStart(8, '0')}`;
  }

  /** The identity line for server-authored commits. */
  identityLine(): string {
    const epoch = this.clock.epochSec();
    return `${this.viewer.name} <${this.viewer.email}> ${epoch} +0000`;
  }

  /** Global (Relay) id for a repository: opaque, stable across reads. */
  repoGlobalId(repo: Repo): string {
    return Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64');
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64');
  }

  pullGlobalId(repo: Repo, pull: PullRequest): string {
    return Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64');
  }

  commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
    return Buffer.from(`IssueComment:${repo.id}:${issue.number}:${commentId}`, 'utf8').toString('base64');
  }

  /** Decode a global id into {kind, repoId, number, commentId} or null. */
  decodeGlobalId(id: string): { kind: string; repoId: number; number: number; commentId: number } | null {
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const parts = text.split(':');
      if (parts.length < 2) return null;
      const kind = parts[0] as string;
      const repoId = Number(parts[1]);
      if (!Number.isInteger(repoId) || repoId <= 0) return null;
      return { kind, repoId, number: Number(parts[2] ?? 0), commentId: Number(parts[3] ?? 0) };
    } catch {
      return null;
    }
  }

  repoByDatabaseId(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }
}
