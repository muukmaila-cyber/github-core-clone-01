// MCP (Model Context Protocol) over Streamable HTTP at POST /mcp.
//
// Both protocol eras the suite accepts:
// - modern 2026-07-28: `server/discover` answers identity, capabilities and
//   supportedVersions; every request declares its revision in `_meta`.
// - legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`.
// The server answers both, so the client negotiates modern.
//
// Tools (all six the suite requires, exact canonical names): create_repo,
// get_repo, create_issue, list_issues, create_pull_request,
// merge_pull_request. Every tool has a non-empty description and an
// inputSchema of type object; tools/list is byte-identical across calls
// (one constant array). Tool calls run against the same store as REST, so
// an object created over MCP reads back over /api/v3 unchanged.

import type { RestHandler } from './rest.ts';
import type { Store } from './store.ts';

export const MCP_SERVER_NAME = 'forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_REVISION = '2026-07-28';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function jsonResponse(status: number, value: unknown): McpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'),
  };
}

export function handleMcp(store: Store, rest: RestHandler, bodyText: string, authorized: boolean): McpResponse {
  if (!authorized) {
    return jsonResponse(401, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'Requires authentication' },
    });
  }
  let request: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    request = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse(400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  }
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  // A notification (no id) is answered 202 with no body.
  if (id === null && method !== '') {
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }
  const result = (value: unknown): McpResponse => jsonResponse(200, { jsonrpc: '2.0', id, result: value });
  const rpcError = (code: number, message: string): McpResponse =>
    jsonResponse(200, { jsonrpc: '2.0', id, error: { code, message } });

  const params = (typeof request.params === 'object' && request.params !== null
    ? request.params
    : {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return result({
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      capabilities: { tools: {} },
      protocolVersion: MCP_REVISION,
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        'io.modelcontextprotocol/protocolVersion': MCP_REVISION,
      },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
    const negotiated = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_REVISION;
    return result({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'ping') return result({});
  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null
      ? params.arguments
      : {}) as Record<string, unknown>;
    const tool = TOOLS.find((entry) => entry.name === name);
    if (!tool) return rpcError(-32601, `Unknown tool: ${name}`);
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return result(toolError(`Missing required argument: ${missing.join(', ')}`));
    }
    const viewer = store.viewer.login;
    const ownerOf = (value: unknown): string => (typeof value === 'string' && value !== '' ? value : viewer);
    const repoOf = (argsObj: Record<string, unknown>): string => {
      if (typeof argsObj.repo === 'string' && argsObj.repo !== '') return argsObj.repo;
      if (typeof argsObj.name === 'string' && argsObj.name !== '') return argsObj.name;
      const full = typeof argsObj.full_name === 'string' ? argsObj.full_name : '';
      const parts = full.split('/');
      return parts.length === 2 ? (parts[1] as string) : '';
    };
    const owner = ownerOf(args.owner ?? (typeof args.full_name === 'string' ? args.full_name.split('/')[0] : undefined));
    const repoName = repoOf(args);
    const repo = repoName === '' ? undefined : store.getRepo(owner, repoName);
    switch (name) {
      case 'create_repo': {
        const repoNameArg = typeof args.name === 'string' ? args.name : '';
        if (store.getRepo(viewer, repoNameArg) !== undefined) {
          return result(toolError(`Repository ${viewer}/${repoNameArg} already exists`));
        }
        const created = store.createRepo(
          viewer,
          repoNameArg,
          typeof args.description === 'string' ? args.description : '',
          args.private === true,
        );
        return result(toolResult(rest.repoJson(created)));
      }
      case 'get_repo': {
        if (!repo) return result(toolError(`Repository ${owner}/${repoName} not found`));
        return result(toolResult(rest.repoJson(repo)));
      }
      case 'create_issue': {
        if (!repo) return result(toolError(`Repository ${owner}/${repoName} not found`));
        const title = typeof args.title === 'string' ? args.title : '';
        const body = typeof args.body === 'string' ? args.body : '';
        const issue = rest.createIssueObj(repo, title, body, []);
        if (!issue) return result(toolError('Could not create the issue'));
        return result(toolResult(rest.issueJson(repo, issue)));
      }
      case 'list_issues': {
        if (!repo) return result(toolError(`Repository ${owner}/${repoName} not found`));
        const state = typeof args.state === 'string' ? args.state : 'open';
        const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        return result(toolResult({ issues: issues.map((issue) => rest.issueJson(repo, issue)) }));
      }
      case 'create_pull_request': {
        if (!repo) return result(toolError(`Repository ${owner}/${repoName} not found`));
        const title = typeof args.title === 'string' ? args.title : '';
        const body = typeof args.body === 'string' ? args.body : '';
        const head = typeof args.head === 'string' ? args.head : '';
        const base = typeof args.base === 'string' ? args.base : '';
        const pull = rest.createPullObj(repo, head, base, title, body);
        if (!pull) return result(toolError('Could not create the pull request'));
        return result(toolResult(rest.pullJson(repo, pull)));
      }
      case 'merge_pull_request': {
        if (!repo) return result(toolError(`Repository ${owner}/${repoName} not found`));
        const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
        const pull = repo.findPull(number);
        if (!pull) return result(toolError(`Pull request #${number} not found`));
        const sha = rest.mergePullObj(repo, pull);
        if (sha === null) return result(toolError('Could not merge the pull request'));
        return result(toolResult({ merged: true, number: pull.number, pull_number: pull.number, sha }));
      }
      default:
        return rpcError(-32601, `Unknown tool: ${name}`);
    }
  }
  return rpcError(-32601, `Method not found: ${method}`);
}
