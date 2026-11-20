// REST API v3, over the shared store.
//
// Contract (from the suite):
// - Every request carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; without
//   it, 401 JSON {"message": ...}. A repo under another owner is 404, never 403.
// - Every reply is application/json with a non-empty X-GitHub-Request-Id.
// - Errors are always {"message": <non-empty string>}; malformed JSON is 400;
//   an unknown /api/v3 route is 404 JSON.
// - GET /api/v3/ is 200 with X-OAuth-Scopes containing repo and read:org.
// - Issue and pull request numbers share one sequence per repository.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Decoded path segments under /api/v3 (without the prefix). */
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
  /** Absolute origin, e.g. http://127.0.0.1:12345 — for pagination Link URLs. */
  baseUrl: string;
}

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function jsonBody(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function parseBody(req: RestRequest): { ok: boolean; value: Record<string, unknown> | null } {
  if (req.body.length === 0) return { ok: true, value: null };
  try {
    const parsed = JSON.parse(req.body.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, value: null };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, value: null };
  }
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): { pageItems: T[]; hasNext: boolean; lastPage: number } {
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), hasNext: page < lastPage, lastPage };
}

export class RestHandler {
  store: Store;
  expectedToken: string;

  constructor(store: Store) {
    this.store = store;
    this.expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  }

  private respond(status: number, body: unknown, extra: Record<string, string> = {}): RestResponse {
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': this.store.nextRequestId(),
      ...extra,
    };
    if (status === 204) return { status, headers, body: Buffer.alloc(0) };
    return { status, headers, body: jsonBody(body) };
  }

  private error(status: number, message: string): RestResponse {
    return this.respond(status, { message });
  }

  private auth(req: RestRequest): boolean {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (token === '') return false;
    if (this.expectedToken !== '') return token === this.expectedToken;
    return true;
  }

  private viewerRepo(req: RestRequest, owner: string, name: string): Repo | null {
    if (owner !== this.store.viewer.login) return null;
    return this.store.getRepo(owner, name) ?? null;
  }

  repoJson(repo: Repo): Record<string, unknown> {
    const owner = { login: repo.owner, id: this.store.viewer.id, type: 'User' };
    return {
      id: repo.id,
      node_id: this.store.repoGlobalId(repo),
      name: repo.name,
      full_name: repo.fullName(),
      owner,
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      html_url: `https://example.invalid/${repo.fullName()}`,
      url: `/api/v3/repos/${repo.fullName()}`,
      clone_url: `https://example.invalid/${repo.fullName()}.git`,
      git_url: `git://example.invalid/${repo.fullName()}.git`,
      ssh_url: `git@example.invalid:${repo.fullName()}.git`,
      homepage: null,
      language: null,
      forks_count: 0,
      stargazers_count: 0,
      watchers_count: 0,
      open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
    };
  }

  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      node_id: this.store.issueGlobalId(repo, issue),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
      user: { login: this.store.viewer.login, id: this.store.viewer.id, type: 'User' },
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.state === 'closed' ? issue.updatedAt : null,
      comments: issue.comments.length,
      html_url: `https://example.invalid/${repo.fullName()}/issues/${issue.number}`,
      url: `/api/v3/repos/${repo.fullName()}/issues/${issue.number}`,
    };
  }

  pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
    return {
      id: pull.id,
      node_id: this.store.pullGlobalId(repo, pull),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
      base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
      user: { login: this.store.viewer.login, id: this.store.viewer.id, type: 'User' },
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
      closed_at: pull.state === 'closed' ? pull.updatedAt : null,
      html_url: `https://example.invalid/${repo.fullName()}/pull/${pull.number}`,
      url: `/api/v3/repos/${repo.fullName()}/pulls/${pull.number}`,
    };
  }

  /** Line-level additions/deletions between two texts. */
  private lineDiff(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
    if (oldText === null && newText === null) return { additions: 0, deletions: 0 };
    if (oldText === null) {
      const lines = (newText ?? '').split('\n').filter((line) => line !== '');
      return { additions: Math.max(1, lines.length), deletions: 0 };
    }
    if (newText === null) {
      const lines = oldText.split('\n').filter((line) => line !== '');
      return { additions: 0, deletions: Math.max(1, lines.length) };
    }
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const oldCount = new Map<string, number>();
    for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of newLines) {
      const remaining = oldCount.get(line) ?? 0;
      if (remaining > 0) oldCount.set(line, remaining - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const remaining of oldCount.values()) deletions += remaining;
    return { additions, deletions };
  }

  /** The changed files of a pull request (merge-base vs head). */
  pullFiles(repo: Repo, pull: PullRequest): Record<string, unknown>[] {
    const baseTree = repo.commitTree(pull.baseTip);
    const headTree = repo.commitTree(pull.headSha);
    const diff = repo.diffTrees(baseTree, headTree);
    const out: Record<string, unknown>[] = [];
    const baseFlat = baseTree === null ? new Map() : repo.flattenTree(baseTree);
    const headFlat = headTree === null ? new Map() : repo.flattenTree(headTree);
    for (const [path, newOid] of [...diff.entries()].sort()) {
      const oldEntry = baseFlat.get(path);
      const newEntry = headFlat.get(path);
      const oldText = oldEntry === undefined ? null : (repo.objects.get(oldEntry.oid)?.data.toString('utf8') ?? null);
      const newText = newEntry === undefined ? null : (repo.objects.get(newEntry.oid)?.data.toString('utf8') ?? null);
      const { additions, deletions } = this.lineDiff(oldText, newText);
      const status = oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified';
      out.push({
        filename: path,
        status,
        additions,
        deletions,
        changes: additions + deletions,
        sha: newOid ?? oldEntry?.oid ?? '',
      });
    }
    return out;
  }

  /** Whether merging `pull` now would conflict with the base branch. */
  pullConflicts(repo: Repo, pull: PullRequest): boolean {
    const baseTipTree = repo.commitTree(pull.baseTip);
    const headTree = repo.commitTree(pull.headSha);
    const baseRef = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseRef === undefined) return true;
    const baseCurrentTree = repo.commitTree(baseRef);
    const headChanges = repo.diffTrees(baseTipTree, headTree);
    const baseChanges = repo.diffTrees(baseTipTree, baseCurrentTree);
    for (const [path, headOid] of headChanges) {
      if (baseChanges.has(path) && baseChanges.get(path) !== headOid) return true;
    }
    return false;
  }

  /** Create a commit on `branch` that replaces `path` with `content` (or deletes it). */
  private contentsCommit(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitOid: string; blobOid: string | null } {
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    const baseTree = tip === undefined ? null : repo.commitTree(tip);
    const flat = baseTree === null ? new Map<string, { oid: string; mode: string }>() : repo.flattenTree(baseTree);
    let blobOid: string | null = null;
    if (content !== null) {
      blobOid = hashObject('blob', content);
      repo.objects.set(blobOid, { type: 'blob', data: content });
      flat.set(path, { oid: blobOid, mode: '100644' });
    } else {
      flat.delete(path);
    }
    // Rebuild the tree stack from the flat map.
    const buildLevel = (prefix: string): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [filePath, entry] of flat) {
        if (prefix !== '' && !filePath.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? filePath : filePath.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
        else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (!sub) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(rest.slice(slash + 1), entry);
        }
      }
      for (const [dir, sub] of [...dirs.entries()].sort()) {
        const subPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
        const subFlat = new Map<string, { oid: string; mode: string }>();
        for (const [subPath, entry] of sub) subFlat.set(`${subPrefix}/${subPath}`, entry);
        // Build the subtree from the sub-map directly.
        const subOid = this.buildSubtree(repo, subPrefix, subFlat);
        entries.push({ mode: '40000', name: dir, oid: subOid });
      }
      const treeData = buildTree(entries);
      const treeOid = hashObject('tree', treeData);
      repo.objects.set(treeOid, { type: 'tree', data: treeData });
      return treeOid;
    };
    const treeOid = buildLevel('');
    const identity = this.store.identityLine();
    const commitData = buildCommit({
      tree: treeOid,
      parents: tip === undefined ? [] : [tip],
      author: identity,
      committer: identity,
      message,
    });
    const commitOid = hashObject('commit', commitData);
    repo.objects.set(commitOid, { type: 'commit', data: commitData });
    repo.refs.set(refName, commitOid);
    return { commitOid, blobOid };
  }

  private buildSubtree(repo: Repo, prefix: string, flat: Map<string, { oid: string; mode: string }>): string {
    const entries: { mode: string; name: string; oid: string }[] = [];
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    for (const [filePath, entry] of flat) {
      const rest = filePath.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
      else {
        const dir = rest.slice(0, slash);
        let sub = dirs.get(dir);
        if (!sub) {
          sub = new Map();
          dirs.set(dir, sub);
        }
        sub.set(rest.slice(slash + 1), entry);
      }
    }
    for (const [dir, sub] of [...dirs.entries()].sort()) {
      const subPrefix = `${prefix}/${dir}`;
      const subFlat = new Map<string, { oid: string; mode: string }>();
      for (const [subPath, entry] of sub) subFlat.set(`${subPrefix}/${subPath}`, entry);
      entries.push({ mode: '40000', name: dir, oid: this.buildSubtree(repo, subPrefix, subFlat) });
    }
    const treeData = buildTree(entries);
    const treeOid = hashObject('tree', treeData);
    repo.objects.set(treeOid, { type: 'tree', data: treeData });
    return treeOid;
  }

  /** The tree oid at `path` under `rootTreeOid` ('' for the root itself). */
  private treeOidAtPath(repo: Repo, rootTreeOid: string, path: string): string {
    if (path === '') return rootTreeOid;
    let current = rootTreeOid;
    for (const segment of path.split('/')) {
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 'tree') return '';
      const entry = parseTree(obj.data).find((candidate) => candidate.name === segment);
      if (!entry) return '';
      current = entry.oid;
    }
    return current;
  }

  /** Walk a branch's commits, newest first. */
  private walkCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return out;
  }

  handle(req: RestRequest): RestResponse | null {
    const segments = req.segments;
    if (!this.auth(req)) return this.error(401, 'Requires authentication');
    const method = req.method;

    // GET /api/v3/ — the API root.
    if (segments.length === 0) {
      if (method !== 'GET') return this.error(404, 'Not Found');
      return this.respond(200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      }, { 'x-oauth-scopes': 'repo, read:org' });
    }

    // GET /api/v3/meta
    if (segments.length === 1 && segments[0] === 'meta') {
      if (method !== 'GET') return this.error(404, 'Not Found');
      return this.respond(200, { installed_version: '1.0.0' });
    }

    // GET /api/v3/user, POST /api/v3/user/repos, GET /api/v3/user/repos
    if (segments[0] === 'user') {
      if (segments.length === 1 && method === 'GET') {
        const viewer = this.store.viewer;
        return this.respond(200, { login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email, type: 'User' });
      }
      if (segments.length === 2 && segments[1] === 'repos') {
        if (method === 'GET') {
          const { page, perPage } = pageParams(req.query);
          const repos = this.store.viewerRepos();
          const { pageItems, hasNext, lastPage } = paginate(repos, page, perPage);
          const extra: Record<string, string> = {};
          if (hasNext || page > 1) {
            const links: string[] = [];
            const urlFor = (p: number): string => `${req.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${p}`;
            if (hasNext) links.push(`<${urlFor(page + 1)}>; rel="next"`);
            links.push(`<${urlFor(lastPage)}>; rel="last"`);
            if (page > 1) links.push(`<${urlFor(1)}>; rel="first"`, `<${urlFor(page - 1)}>; rel="prev"`);
            extra.link = links.join(', ');
          }
          return this.respond(200, pageItems.map((repo) => this.repoJson(repo)), extra);
        }
        if (method === 'POST') {
          const parsed = parseBody(req);
          if (!parsed.ok) return this.error(400, 'Problems parsing JSON');
          const body = parsed.value ?? {};
          const name = typeof body.name === 'string' ? body.name : '';
          if (name === '') return this.error(422, 'name is required');
          if (this.store.getRepo(this.store.viewer.login, name) !== undefined) {
            return this.error(422, 'Repository already exists');
          }
          const repo = this.store.createRepo(
            this.store.viewer.login,
            name,
            typeof body.description === 'string' ? body.description : '',
            body.private === true,
          );
          return this.respond(201, this.repoJson(repo));
        }
      }
      return this.error(404, 'Not Found');
    }

    // /api/v3/repos/{owner}/{repo}/...
    if (segments[0] === 'repos' && segments.length >= 3) {
      const owner = decodeURIComponent(segments[1] as string);
      const name = decodeURIComponent(segments[2] as string);
      const repo = this.viewerRepo(req, owner, name);
      if (repo === null) return this.error(404, 'Not Found');
      const rest = segments.slice(3);
      return this.handleRepo(req, repo, rest);
    }

    return this.error(404, 'Not Found');
  }

  private handleRepo(req: RestRequest, repo: Repo, rest: string[]): RestResponse {
    const method = req.method;

    // /repos/{o}/{r} — read, patch, delete.
    if (rest.length === 0) {
      if (method === 'GET') return this.respond(200, this.repoJson(repo));
      if (method === 'PATCH') {
        const parsed = parseBody(req);
        if (!parsed.ok) return this.error(400, 'Problems parsing JSON');
        const body = parsed.value ?? {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        repo.updatedAt = this.store.clock.tick();
        return this.respond(200, this.repoJson(repo));
      }
      if (method === 'DELETE') {
        this.store.deleteRepo(repo.owner, repo.name);
        return this.respond(204, null);
      }
      return this.error(404, 'Not Found');
    }

    const head = rest[0] as string;

    // Branches.
    if (head === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        return this.respond(200, repo.branches().map((branch) => ({ name: branch.name, commit: { sha: branch.sha }, protected: false })));
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(rest[1] as string);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return this.error(404, 'Not Found');
        return this.respond(200, { name: branch, commit: { sha }, protected: false });
      }
      return this.error(404, 'Not Found');
    }

    // Commits.
    if (head === 'commits') {
      if (method !== 'GET') return this.error(404, 'Not Found');
      const branch = req.query.get('sha') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return this.respond(200, []);
      const walked = this.walkCommits(repo, tip);
      const { page, perPage } = pageParams(req.query);
      const { pageItems, hasNext, lastPage } = paginate(walked, page, perPage);
      const extra: Record<string, string> = {};
      if (hasNext) {
        extra.link = `<${req.baseUrl}/api/v3/repos/${repo.fullName()}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}&page=${page + 1}>; rel="next", <${req.baseUrl}/api/v3/repos/${repo.fullName()}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}&page=${lastPage}>; rel="last"`;
      }
      return this.respond(200, pageItems.map((oid) => {
        const commit = parseCommit((repo.objects.get(oid) as { data: Buffer }).data);
        return { sha: oid, commit: { message: commit.message, author: { name: commit.author }, committer: { name: commit.committer } }, author: { login: this.store.viewer.login } };
      }), extra);
    }

    // Contents.
    if (head === 'contents') {
      const path = rest.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
      if (method === 'PUT') return this.putContents(req, repo, path);
      if (method === 'GET') return this.getContents(req, repo, path);
      if (method === 'DELETE') return this.deleteContents(req, repo, path);
      return this.error(404, 'Not Found');
    }

    // Git Data: refs.
    if (head === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const parsed = parseBody(req);
        if (!parsed.ok) return this.error(400, 'Problems parsing JSON');
        const body = parsed.value ?? {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (ref === '' || sha === '') return this.error(422, 'ref and sha are required');
        if (!/^[0-9a-f]{40}$/.test(sha) || repo.objects.get(sha) === undefined) {
          return this.error(422, 'Invalid sha');
        }
        if (repo.refs.has(ref)) return this.error(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return this.respond(201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = rest.slice(2).map((segment) => decodeURIComponent(segment)).join('/');
        const fullRef = `refs/${ref}`;
        const sha = repo.refs.get(fullRef);
        if (sha === undefined) return this.error(404, 'Not Found');
        return this.respond(200, { ref: fullRef, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      }
      return this.error(404, 'Not Found');
    }

    // Labels.
    if (head === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        return this.respond(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      }
      if (method === 'POST' && rest.length === 1) {
        const parsed = parseBody(req);
        if (!parsed.ok) return this.error(400, 'Problems parsing JSON');
        const body = parsed.value ?? {};
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return this.error(422, 'name is required');
        const label = { name, color: typeof body.color === 'string' ? body.color : '000000' };
        repo.labels.set(name, label);
        return this.respond(201, label);
      }
      return this.error(404, 'Not Found');
    }

    // Issues.
    if (head === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') return this.listIssues(req, repo);
        if (method === 'POST') return this.createIssue(req, repo);
      }
      if (rest.length === 2) {
        const number = parseInt(rest[1] as string, 10);
        const issue = repo.findIssue(number);
        if (issue === undefined) return this.error(404, 'Not Found');
        if (method === 'GET') {
          // The read benchmark hits one issue 2,000 times in a row; the
          // serialized body is cached on the issue and cleared on mutation.
          if (issue.cachedJson === null) issue.cachedJson = jsonBody(this.issueJson(repo, issue));
          return {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': this.store.nextRequestId() },
            body: issue.cachedJson,
          };
        }
        if (method === 'PATCH') {
          const parsed = parseBody(req);
          if (!parsed.ok) return this.error(400, 'Problems parsing JSON');
          const body = parsed.value ?? {};
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          issue.updatedAt = this.store.clock.tick();
          issue.cachedJson = null;
          return this.respond(200, this.issueJson(repo, issue));
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const number = parseInt(rest[1] as string, 10);
        const issue = repo.findIssue(number);
        if (issue === undefined) return this.error(404, 'Not Found');
        if (method === 'GET') {
          return this.respond(200, issue.comments.map((comment) => ({
            id: comment.id,
            node_id: this.store.commentGlobalId(repo, issue, comment.id),
            body: comment.body,
            user: { login: this.store.viewer.login, id: this.store.viewer.id, type: 'User' },
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
          })));
        }
        if (method === 'POST') {
          const parsed = parseBody(req);
          if (!parsed.ok) return this.error(400, 'Problems parsing JSON');
          const body = parsed.value ?? {};
          if (typeof body.body !== 'string' || body.body === '') return this.error(422, 'body is required');
          const comment = this.addCommentObj(repo, issue, body.body);
          return this.respond(201, {
            id: comment.id,
            node_id: this.store.commentGlobalId(repo, issue, comment.id),
            body: comment.body,
            user: { login: this.store.viewer.login, id: this.store.viewer.id, type: 'User' },
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
          });
        }
      }
      return this.error(404, 'Not Found');
    }

    // Pull requests.
    if (head === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') return this.listPulls(req, repo);
        if (method === 'POST') return this.createPull(req, repo);
      }
      if (rest.length === 2) {
        const number = parseInt(rest[1] as string, 10);
        const pull = repo.findPull(number);
        if (pull === undefined) return this.error(404, 'Not Found');
        if (method === 'GET') return this.respond(200, this.pullJson(repo, pull));
        if (method === 'PATCH') {
          const parsed = parseBody(req);
          if (!parsed.ok) return this.error(400, 'Problems parsing JSON');
          const body = parsed.value ?? {};
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) pull.state = body.state;
          pull.updatedAt = this.store.clock.tick();
          return this.respond(200, this.pullJson(repo, pull));
        }
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const number = parseInt(rest[1] as string, 10);
        const pull = repo.findPull(number);
        if (pull === undefined) return this.error(404, 'Not Found');
        return this.respond(200, this.pullFiles(repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        return this.mergePull(req, repo, parseInt(rest[1] as string, 10));
      }
      return this.error(404, 'Not Found');
    }

    return this.error(404, 'Not Found');
  }

  private listIssues(req: RestRequest, repo: Repo): RestResponse {
    const state = req.query.get('state') ?? 'open';
    const sort = req.query.get('sort') ?? 'created';
    const direction = req.query.get('direction') ?? 'desc';
    let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    const byCreated = (a: Issue, b: Issue): number => a.createdSeq - b.createdSeq;
    issues = [...issues].sort(sort === 'created' ? byCreated : byCreated);
    if (direction === 'desc') issues.reverse();
    const { page, perPage } = pageParams(req.query);
    const { pageItems, hasNext, lastPage } = paginate(issues, page, perPage);
    const extra: Record<string, string> = {};
    if (hasNext) {
      extra.link = `<${req.baseUrl}/api/v3/repos/${repo.fullName()}/issues?state=${state}&sort=${sort}&direction=${direction}&per_page=${perPage}&page=${page + 1}>; rel="next", <${req.baseUrl}/api/v3/repos/${repo.fullName()}/issues?state=${state}&sort=${sort}&direction=${direction}&per_page=${perPage}&page=${lastPage}>; rel="last"`;
    }
    return this.respond(200, pageItems.map((issue) => this.issueJson(repo, issue)), extra);
  }

  /** Shared issue creation (REST and GraphQL use the same path). */
  createIssueObj(repo: Repo, title: string, body: string, labelNames: string[]): Issue | null {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return null;
    }
    const labels = labelNames.map((name) => repo.labels.get(name) as { name: string; color: string });
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const now = this.store.clock.tick();
    const issue: Issue = {
      number,
      id: repo.nextIssueId,
      title,
      body,
      state: 'open',
      labels,
      createdAt: now,
      updatedAt: now,
      createdSeq: repo.seq,
      comments: [],
      cachedJson: null,
    };
    repo.nextIssueId += 1;
    repo.seq += 1;
    repo.issues.push(issue);
    return issue;
  }

  /** Shared comment creation (REST and GraphQL use the same path). */
  addCommentObj(repo: Repo, issue: Issue, body: string): { id: number; body: string; createdAt: string } {
    const comment = { id: repo.nextCommentId, body, createdAt: this.store.clock.tick() };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    issue.updatedAt = this.store.clock.tick();
    issue.cachedJson = null;
    return comment;
  }

  private createIssue(req: RestRequest, repo: Repo): RestResponse {
    const parsed = parseBody(req);
    if (!parsed.ok) return this.error(400, 'Problems parsing JSON');
    const body = parsed.value ?? {};
    if (typeof body.title !== 'string' || body.title === '') return this.error(422, 'title is required');
    const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
    const issue = this.createIssueObj(repo, body.title, typeof body.body === 'string' ? body.body : '', labelNames);
    if (issue === null) return this.error(422, 'a label does not exist');
    return this.respond(201, this.issueJson(repo, issue));
  }

  private listPulls(req: RestRequest, repo: Repo): RestResponse {
    const state = req.query.get('state') ?? 'open';
    let pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
    pulls = [...pulls].sort((a, b) => b.createdSeq - a.createdSeq);
    const { page, perPage } = pageParams(req.query);
    const { pageItems, hasNext, lastPage } = paginate(pulls, page, perPage);
    const extra: Record<string, string> = {};
    if (hasNext) {
      extra.link = `<${req.baseUrl}/api/v3/repos/${repo.fullName()}/pulls?state=${state}&per_page=${perPage}&page=${page + 1}>; rel="next", <${req.baseUrl}/api/v3/repos/${repo.fullName()}/pulls?state=${state}&per_page=${perPage}&page=${lastPage}>; rel="last"`;
    }
    return this.respond(200, pageItems.map((pull) => this.pullJson(repo, pull)), extra);
  }

  /** Shared pull request creation (REST and GraphQL use the same path). */
  createPullObj(repo: Repo, head: string, base: string, title: string, body: string): PullRequest | null {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return null;
    const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
    if (duplicate !== undefined) return null;
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const now = this.store.clock.tick();
    const pull: PullRequest = {
      number,
      id: repo.nextIssueId,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      headSha,
      baseRef: base,
      baseSha,
      baseTip: baseSha,
      createdAt: now,
      updatedAt: now,
      createdSeq: repo.seq,
    };
    repo.nextIssueId += 1;
    repo.seq += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /**
   * Shared squash merge (REST and GraphQL use the same path).
   * Returns the merge commit sha, or null when the pull cannot be merged
   * (already closed, conflicting, or head without a tree).
   */
  mergePullObj(repo: Repo, pull: PullRequest): string | null {
    if (pull.state !== 'open') return null;
    if (this.pullConflicts(repo, pull)) return null;
    const headTree = repo.commitTree(pull.headSha);
    if (headTree === null) return null;
    const identity = this.store.identityLine();
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const commitData = buildCommit({
      tree: headTree,
      parents: baseTip === undefined ? [] : [baseTip],
      author: identity,
      committer: identity,
      message: pull.title,
    });
    const commitOid = hashObject('commit', commitData);
    repo.objects.set(commitOid, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.store.clock.tick();
    pull.mergeCommitSha = commitOid;
    pull.updatedAt = pull.mergedAt;
    return commitOid;
  }

  private createPull(req: RestRequest, repo: Repo): RestResponse {
    const parsed = parseBody(req);
    if (!parsed.ok) return this.error(400, 'Problems parsing JSON');
    const body = parsed.value ?? {};
    const head = typeof body.head === 'string' ? body.head : '';
    const base = typeof body.base === 'string' ? body.base : '';
    const title = typeof body.title === 'string' ? body.title : '';
    if (head === '' || base === '' || title === '') return this.error(422, 'head, base and title are required');
    const pull = this.createPullObj(repo, head, base, title, typeof body.body === 'string' ? body.body : '');
    if (pull === null) return this.error(422, 'head or base branch does not exist, or a pull request already exists');
    return this.respond(201, this.pullJson(repo, pull));
  }

  private mergePull(req: RestRequest, repo: Repo, number: number): RestResponse {
    const pull = repo.findPull(number);
    if (pull === undefined) return this.error(404, 'Not Found');
    if (pull.state !== 'open') return this.error(405, 'Pull request is already closed');
    if (this.pullConflicts(repo, pull)) return this.error(405, 'Merge conflict');
    const parsed = parseBody(req);
    if (!parsed.ok) return this.error(400, 'Problems parsing JSON');
    const sha = this.mergePullObj(repo, pull);
    if (sha === null) return this.error(405, 'Merge conflict');
    return this.respond(200, { merged: true, sha, message: pull.title });
  }

  private putContents(req: RestRequest, repo: Repo, path: string): RestResponse {
    const parsed = parseBody(req);
    if (!parsed.ok) return this.error(400, 'Problems parsing JSON');
    const body = parsed.value ?? {};
    if (typeof body.message !== 'string' || typeof body.content !== 'string') {
      return this.error(422, 'message and content are required');
    }
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const flat = tip === undefined ? new Map() : repo.flattenTree(repo.commitTree(tip) ?? '');
    const existing = flat.get(path);
    const isUpdate = existing !== undefined;
    if (isUpdate) {
      if (typeof body.sha !== 'string' || body.sha !== existing.oid) {
        return this.error(409, 'sha does not match the current file');
      }
    }
    let content: Buffer;
    try {
      content = Buffer.from(body.content, 'base64');
    } catch {
      return this.error(422, 'content is not valid base64');
    }
    const { commitOid, blobOid } = this.contentsCommit(repo, branch, path, content, body.message);
    repo.updatedAt = this.store.clock.tick();
    return this.respond(isUpdate ? 200 : 201, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        size: content.length,
        encoding: 'base64',
        content: body.content,
      },
      commit: { sha: commitOid, message: body.message },
    });
  }

  private getContents(req: RestRequest, repo: Repo, path: string): RestResponse {
    const branch = req.query.get('ref') ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return this.error(404, 'Not Found');
    const treeOid = repo.commitTree(tip);
    if (treeOid === null) return this.error(404, 'Not Found');
    const flat = repo.flattenTree(treeOid);
    const entry = flat.get(path);
    if (entry !== undefined) {
      const obj = repo.objects.get(entry.oid);
      if (!obj) return this.error(404, 'Not Found');
      return this.respond(200, {
        type: 'file',
        encoding: 'base64',
        size: obj.data.length,
        name: path.split('/').pop() ?? path,
        path,
        sha: entry.oid,
        content: obj.data.toString('base64'),
      });
    }
    // Directory listing: entries directly under `path`.
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { type: string; oid: string; path: string }>();
    for (const [filePath, fileEntry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) children.set(rest, { type: 'file', oid: fileEntry.oid, path: filePath });
      else {
        const dirName = rest.slice(0, slash);
        const dirPath = `${prefix}${dirName}`;
        const dirOid = this.treeOidAtPath(repo, treeOid, dirPath);
        children.set(dirName, { type: 'dir', oid: dirOid, path: dirPath });
      }
    }
    if (children.size === 0) return this.error(404, 'Not Found');
    return this.respond(200, [...children.entries()].sort().map(([name, child]) => ({
      type: child.type,
      name,
      path: child.path,
      sha: child.oid,
      size: child.type === 'file' ? (repo.objects.get(child.oid)?.data.length ?? 0) : 0,
    })));
  }

  private deleteContents(req: RestRequest, repo: Repo, path: string): RestResponse {
    const parsed = parseBody(req);
    if (!parsed.ok) return this.error(400, 'Problems parsing JSON');
    const body = parsed.value ?? {};
    if (typeof body.message !== 'string' || typeof body.sha !== 'string') {
      return this.error(422, 'message and sha are required');
    }
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return this.error(404, 'Not Found');
    const flat = repo.flattenTree(repo.commitTree(tip) ?? '');
    const existing = flat.get(path);
    if (existing === undefined) return this.error(404, 'Not Found');
    if (existing.oid !== body.sha) return this.error(409, 'sha does not match the current file');
    const { commitOid } = this.contentsCommit(repo, branch, path, null, body.message);
    repo.updatedAt = this.store.clock.tick();
    return this.respond(200, { commit: { sha: commitOid, message: body.message } });
  }
}
