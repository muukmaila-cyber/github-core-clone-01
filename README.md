# github-core-clone-01

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/muukmaila-cyber/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/muukmaila-cyber/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process, built for the
[make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01).

One in-memory store drives every surface, so a change made through one
interface is visible through all the others:

- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch`) and v0
  (`upload-pack`, `receive-pack`), shallow clones, thin packs, delta
  resolution, fast-forward-only pushes with per-ref report-status.
- **REST API v3** — repositories, contents, git refs, branches, commits,
  issues, comments, labels and pull requests with squash merge.
- **GraphQL v4** — viewer, repository, issues, pull requests, mutations
  (`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`,
  `addComment`), Relay global ids, cursor pagination, introspection and
  batched operations.
- **MCP** — JSON-RPC 2.0 over Streamable HTTP, `server/discover` (2026-07-28)
  and the legacy `initialize` handshake, six repo/issue/PR tools.

## Run

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`,
answers `/healthz`, and polls `$MAKEFUN_ENV_URL/done` until the trial ends.
It needs only the Node.js standard library: no install step, no network,
no git binary.

## Layout

- `main.ts` — entry lifecycle (bind, register, wait for done).
- `src/app.ts` — HTTP server and routing.
- `src/store.ts` — the single store: git objects, refs, issues, PRs.
- `src/pack.ts` — packfile read/write and delta resolution.
- `src/git.ts` — smart HTTP (pkt-line, v2/v0, receive-pack).
- `src/rest.ts` — REST v3.
- `src/graphql.ts` — GraphQL parser and executor.
- `src/mcp.ts` — MCP JSON-RPC endpoint.
- `src/scenario.ts` — the deterministic viewer identity derivation.
