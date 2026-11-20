// The HTTP server: one process, one store, four surfaces.
//
// Routing:
//   GET  /healthz                        -> 200 {"ok":true} (the boot probe)
//   /api/v3/*                           -> REST v3
//   POST /api/graphql                   -> GraphQL v4
//   POST /mcp                           -> MCP (JSON-RPC 2.0, Streamable HTTP)
//   /{owner}/{repo}.git/info/refs      -> git advertisement (v0 or v2)
//   /{owner}/{repo}.git/git-upload-pack -> git fetch / ls-refs
//   /{owner}/{repo}.git/git-receive-pack -> git push
//
// Every reply carries X-GitHub-Request-Id. All state lives in the one
// Store, so a change through any surface is visible through the others.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit, type GitKind } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { RestHandler, type RestRequest } from './rest.ts';
import { viewerIdentity } from './scenario.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function send(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, requestId: string): void {
  send(res, status, JSON_TYPE, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), requestId);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : '';
}

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const headerValue = header(req, 'authorization');
  const token = headerValue.startsWith('Bearer ') ? headerValue.slice('Bearer '.length) : '';
  if (token === '') return false;
  if (expected !== '') return token === expected;
  return true;
}

export function createApp(): Server {
  const store = new Store(viewerIdentity());
  const rest = new RestHandler(store);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const requestId = store.nextRequestId();
      const method = req.method ?? 'GET';
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return;
      }
      const path = url.pathname;
      const host = header(req, 'host') || '127.0.0.1';
      const baseUrl = `http://${host}`;

      try {
        // The boot probe.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          const segments = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
          const headers: Record<string, string | undefined> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            headers[key] = Array.isArray(value) ? value[0] : value;
          }
          const restReq: RestRequest = { method, segments, query: url.searchParams, headers, body, baseUrl };
          const answer = rest.handle(restReq);
          const allHeaders: Record<string, string> = { 'x-github-request-id': requestId, ...answer.headers };
          res.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': answer.body.length, ...allHeaders });
          res.end(answer.body);
          return;
        }

        // GraphQL v4.
        if (method === 'POST' && path === '/api/graphql') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          const body = await readBody(req);
          const answer = handleGraphQL(store, rest, body.toString('utf8'));
          send(res, answer.status, JSON_TYPE, answer.body, requestId);
          return;
        }

        // MCP.
        if (method === 'POST' && path === '/mcp') {
          const body = await readBody(req);
          const answer = handleMcp(store, rest, body.toString('utf8'), authorized(req));
          const contentType = answer.headers['content-type'] ?? JSON_TYPE;
          res.writeHead(answer.status, { 'content-type': contentType, 'content-length': answer.body.length, 'x-github-request-id': requestId });
          res.end(answer.body);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const tail = gitMatch[3] as string;
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          const v2 = header(req, 'git-protocol') === 'version=2';
          if (tail === 'info/refs') {
            const service = url.searchParams.get('service') ?? '';
            let kind: GitKind | null = null;
            if (service === 'git-upload-pack') kind = 'info-refs-upload';
            else if (service === 'git-receive-pack') kind = 'info-refs-receive';
            if (kind === null) {
              sendJson(res, 404, { message: 'Not Found' }, requestId);
              return;
            }
            const answer = handleGit({ store, owner, repoName, kind, gitProtocolV2: v2, body: Buffer.alloc(0) });
            send(res, answer.status, answer.contentType, answer.body, requestId);
            return;
          }
          const body = await readBody(req);
          const kind: GitKind = tail === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
          const answer = handleGit({ store, owner, repoName, kind, gitProtocolV2: v2, body });
          send(res, answer.status, answer.contentType, answer.body, requestId);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (err) {
        // The server never dies on one bad request.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' }, requestId);
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });

  return server;
}
