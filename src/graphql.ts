// GraphQL v4, over the shared store.
//
// The suite sends only fixed documents (viewer, repository fields,
// introspection, issue/PR reads, the five mutations, node(id:), batched
// operations), so this is a small parser + executor for the GraphQL
// language as those documents use it — selection sets, aliases, variables,
// arguments (including nested input objects), inline fragments and named
// fragment spreads — not a general-purpose engine. Responses follow the
// requested selection sets exactly; an unknown field is HTTP 200 with an
// `errors` array naming the field; an unknown repository is
// data.repository = null with no errors.

import type { RestHandler } from './rest.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: parseInt(input.slice(i, j), 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, unknown>;
  selection: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

class Parser {
  tokens: Token[];
  pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): (OperationNode | FragmentNode)[] {
    const defs: (OperationNode | FragmentNode)[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        defs.push({ kind: 'operation', operation: 'query', name: null, variables: {}, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value as string;
        const variables: Record<string, unknown> = {};
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
          this.next();
          while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
            if ((this.peek() as { value: string }).value === '$') this.next();
            const varName = this.expectName();
            this.expectPunct(':');
            // Type: a name, possibly wrapped in [] and suffixed with !.
            while (this.peek().kind === 'name' || ((this.peek() as { value: string }).value === '[') || ((this.peek() as { value: string }).value === ']') || ((this.peek() as { value: string }).value === '!')) this.next();
            if ((this.peek() as { value: string }).value === '=') {
              this.next();
              variables[varName] = this.valueFromNode(this.parseValue());
            } else {
              variables[varName] = undefined;
            }
          }
          this.expectPunct(')');
        }
        defs.push({ kind: 'operation', operation, name, variables, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in fragment');
        const typeCondition = this.expectName();
        defs.push({ kind: 'fragment', name, typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token)} in GraphQL document`);
      }
    }
    return defs;
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const next = this.peek();
        if (next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else if (next.kind === 'name') {
          selections.push({ kind: 'spread', name: this.next().value as string });
        } else {
          selections.push({ kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if ((this.peek() as { value: string }).value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args: { name: string; value: ValueNode }[] = [];
      if ((this.peek() as { value: string }).value === '(') {
        this.next();
        while (!((this.peek() as { value: string }).value === ')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expectPunct(')');
      }
      let selection: SelectionNode[] = [];
      if ((this.peek() as { value: string }).value === '{') selection = this.parseSelectionSet();
      selections.push({ alias, name, args, selection });
    }
    this.expectPunct('}');
    return selections;
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!((this.peek() as { value: string }).value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!((this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }

  valueFromNode(node: ValueNode): unknown {
    if (node.kind === 'string' || node.kind === 'int' || node.kind === 'boolean') return node.value;
    if (node.kind === 'null') return null;
    if (node.kind === 'enum') return node.value;
    if (node.kind === 'list') return node.values.map((child) => this.valueFromNode(child));
    if (node.kind === 'object') {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = this.valueFromNode(field.value);
      return out;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'isPrivate'],
  SearchType: [],
  Viewer: ['login', 'id', 'name'],
  Query: ['viewer', 'repository', 'node', '__type'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER'];

interface ExecContext {
  store: Store;
  rest: RestHandler;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string }[];
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  if (node.kind === 'variable') return variables[node.name];
  if (node.kind === 'string' || node.kind === 'int' || node.kind === 'boolean') return node.value;
  if (node.kind === 'null') return null;
  if (node.kind === 'enum') return node.value;
  if (node.kind === 'list') return node.values.map((child) => resolveValue(child, variables));
  if (node.kind === 'object') {
    const out: Record<string, unknown> = {};
    for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
    return out;
  }
  return undefined;
}

function argValue(field: FieldNode, name: string, ctx: ExecContext): unknown {
  const arg = field.args.find((entry) => entry.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, ctx.variables);
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? parseInt(match[1] as string, 10) : 0;
  } catch {
    return 0;
  }
}

type ScopeValue =
  | { kind: 'query' }
  | { kind: 'viewer' }
  | { kind: 'repository'; repo: Repo }
  | { kind: 'issue'; repo: Repo; issue: Issue }
  | { kind: 'pull'; repo: Repo; pull: PullRequest }
  | { kind: 'type'; name: string }
  | { kind: 'issues-connection'; repo: Repo; issues: Issue[] }
  | { kind: 'pulls-connection'; repo: Repo; pulls: PullRequest[] }
  | { kind: 'files-connection'; repo: Repo; pull: PullRequest }
  | { kind: 'comment-edge'; id: string; body: string }
  | { kind: 'page-info'; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'owner'; login: string }
  | { kind: 'branch-ref'; name: string }
  | { kind: 'mutation-issue'; repo: Repo; issue: Issue }
  | { kind: 'mutation-pull'; repo: Repo; pull: PullRequest }
  | { kind: 'comment-node'; id: string; body: string };

function typeNameOf(scope: ScopeValue): string {
  switch (scope.kind) {
    case 'query': return 'Query';
    case 'viewer': return 'Viewer';
    case 'repository': return 'Repository';
    case 'issue': return 'Issue';
    case 'pull': return 'PullRequest';
    case 'type': return '__Type';
    case 'issues-connection': return 'IssueConnection';
    case 'pulls-connection': return 'PullRequestConnection';
    case 'files-connection': return 'PullRequestChangedFilesConnection';
    case 'comment-edge': return 'IssueCommentEdge';
    case 'page-info': return 'PageInfo';
    case 'owner': return 'User';
    case 'branch-ref': return 'Ref';
    case 'mutation-issue': return 'Issue';
    case 'mutation-pull': return 'PullRequest';
    case 'comment-node': return 'IssueComment';
  }
}

function executeSelections(scope: ScopeValue, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelections(scope, fragment.selection, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeNameOf(scope)) {
        Object.assign(out, executeSelections(scope, selection.selection, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = executeField(scope, selection, ctx);
  }
  return out;
}

function unknownField(scope: ScopeValue, field: FieldNode, ctx: ExecContext): null {
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeNameOf(scope)}".` });
  return null;
}

function executeField(scope: ScopeValue, field: FieldNode, ctx: ExecContext): unknown {
  const { store, rest } = ctx;

  if (scope.kind === 'query') {
    if (field.name === 'viewer') {
      return executeSelections({ kind: 'viewer' }, field.selection, ctx);
    }
    if (field.name === 'repository') {
      const owner = argValue(field, 'owner', ctx);
      const name = argValue(field, 'name', ctx);
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      if (owner !== store.viewer.login) return null;
      const repo = store.getRepo(owner, name);
      if (!repo) return null;
      return executeSelections({ kind: 'repository', repo }, field.selection, ctx);
    }
    if (field.name === 'node') {
      const id = argValue(field, 'id', ctx);
      if (typeof id !== 'string') return null;
      const decoded = store.decodeGlobalId(id);
      if (!decoded) return null;
      const repo = store.repoByDatabaseId(decoded.repoId);
      if (!repo) return null;
      if (decoded.kind === 'Repository') return executeSelections({ kind: 'repository', repo }, field.selection, ctx);
      if (decoded.kind === 'Issue') {
        const issue = repo.findIssue(decoded.number);
        if (!issue) return null;
        return executeSelections({ kind: 'issue', repo, issue }, field.selection, ctx);
      }
      if (decoded.kind === 'PullRequest') {
        const pull = repo.findPull(decoded.number);
        if (!pull) return null;
        return executeSelections({ kind: 'pull', repo, pull }, field.selection, ctx);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = argValue(field, 'name', ctx);
      if (typeof name !== 'string') return null;
      return executeSelections({ kind: 'type', name }, field.selection, ctx);
    }
    if (field.name === '__schema') return null;
    return unknownField(scope, field, ctx);
  }

  if (scope.kind === 'viewer') {
    if (field.name === 'login') return store.viewer.login;
    if (field.name === 'id') return store.viewer.id;
    if (field.name === 'name') return store.viewer.name;
    return unknownField(scope, field, ctx);
  }

  if (scope.kind === 'repository') {
    const repo = scope.repo;
    switch (field.name) {
      case 'id': return store.repoGlobalId(repo);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return repo.fullName();
      case 'owner': return executeSelections({ kind: 'owner', login: repo.owner }, field.selection, ctx);
      case 'defaultBranchRef': {
        return executeSelections({ kind: 'branch-ref', name: repo.defaultBranch }, field.selection, ctx);
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'isPrivate': return repo.private;
      case 'createdAt': return repo.createdAt;
      case 'updatedAt': return repo.updatedAt;
      case 'issue': {
        const number = argValue(field, 'number', ctx);
        if (typeof number !== 'number') return null;
        const issue = repo.findIssue(number);
        if (!issue) return null;
        return executeSelections({ kind: 'issue', repo, issue }, field.selection, ctx);
      }
      case 'issues': {
        const first = typeof argValue(field, 'first', ctx) === 'number' ? (argValue(field, 'first', ctx) as number) : 100;
        const after = argValue(field, 'after', ctx);
        const states = argValue(field, 'states', ctx);
        const orderBy = argValue(field, 'orderBy', ctx);
        let issues = [...repo.issues];
        if (Array.isArray(states)) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        if (orderBy !== undefined && typeof orderBy === 'object' && orderBy !== null) {
          const direction = (orderBy as Record<string, unknown>).direction;
          issues.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
        } else {
          issues.sort((a, b) => a.createdSeq - b.createdSeq);
        }
        const afterNumber = numberFromCursor(after);
        const restIssues = issues.filter((issue) => issue.number > afterNumber);
        const page = restIssues.slice(0, first);
        const connection: ScopeValue = { kind: 'issues-connection', repo, issues: page };
        // pageInfo needs the full remainder, so stash it on the scope via a
        // side channel: encode in a wrapper object the connection resolver
        // reads. Simpler: recompute inside the connection resolver from
        // `after` + `first` — see below.
        (connection as unknown as { _all: Issue[]; _first: number })._all = restIssues;
        (connection as unknown as { _all: Issue[]; _first: number })._first = first;
        return executeSelections(connection, field.selection, ctx);
      }
      case 'pullRequests': {
        const first = typeof argValue(field, 'first', ctx) === 'number' ? (argValue(field, 'first', ctx) as number) : 100;
        const pulls = repo.pulls.filter((pull) => pull.state === 'open').slice(0, first);
        return executeSelections({ kind: 'pulls-connection', repo, pulls }, field.selection, ctx);
      }
      case 'pullRequest': {
        const number = argValue(field, 'number', ctx);
        if (typeof number !== 'number') return null;
        const pull = repo.findPull(number);
        if (!pull) return null;
        return executeSelections({ kind: 'pull', repo, pull }, field.selection, ctx);
      }
      default: return unknownField(scope, field, ctx);
    }
  }

  if (scope.kind === 'issue' || scope.kind === 'mutation-issue') {
    const issue = scope.issue;
    switch (field.name) {
      case 'id': return store.issueGlobalId(scope.repo, issue);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state.toUpperCase();
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      default: return unknownField(scope, field, ctx);
    }
  }

  if (scope.kind === 'pull' || scope.kind === 'mutation-pull') {
    const pull = scope.pull;
    switch (field.name) {
      case 'id': return store.pullGlobalId(scope.repo, pull);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.state.toUpperCase();
      case 'merged': return pull.merged;
      case 'mergeable': return rest.pullConflicts(scope.repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'headRefOid': return pull.headSha;
      case 'baseRefOid': return pull.baseSha;
      case 'createdAt': return pull.createdAt;
      case 'updatedAt': return pull.updatedAt;
      case 'files': {
        const first = typeof argValue(field, 'first', ctx) === 'number' ? (argValue(field, 'first', ctx) as number) : 100;
        void first;
        return executeSelections({ kind: 'files-connection', repo: scope.repo, pull }, field.selection, ctx);
      }
      default: return unknownField(scope, field, ctx);
    }
  }

  if (scope.kind === 'issues-connection') {
    const side = scope as unknown as { _all?: Issue[]; _first?: number };
    switch (field.name) {
      case 'nodes':
        return scope.issues.map((issue) => executeSelections({ kind: 'issue', repo: scope.repo, issue }, field.selection, ctx));
      case 'edges':
        return scope.issues.map((issue) => {
          const edge: Record<string, unknown> = {};
          for (const sel of field.selection) {
            if (sel.kind !== 'spread' && sel.kind !== 'inline') {
              const edgeField = sel as FieldNode;
              if (edgeField.name === 'node') {
                edge[edgeField.alias ?? 'node'] = executeSelections({ kind: 'issue', repo: scope.repo, issue }, edgeField.selection, ctx);
              } else if (edgeField.name === 'cursor') {
                edge[edgeField.alias ?? 'cursor'] = cursorFor(issue.number);
              }
            }
          }
          return edge;
        });
      case 'pageInfo': {
        const all = side._all ?? scope.issues;
        const first = side._first ?? scope.issues.length;
        const hasNextPage = all.length > first;
        const endCursor = scope.issues.length > 0 ? cursorFor(scope.issues[scope.issues.length - 1]?.number ?? 0) : null;
        return executeSelections({ kind: 'page-info', hasNextPage, endCursor }, field.selection, ctx);
      }
      case 'totalCount':
        return scope.repo.issues.length;
      default: return unknownField(scope, field, ctx);
    }
  }

  if (scope.kind === 'pulls-connection') {
    switch (field.name) {
      case 'nodes':
        return scope.pulls.map((pull) => executeSelections({ kind: 'pull', repo: scope.repo, pull }, field.selection, ctx));
      case 'edges':
        return scope.pulls.map((pull) => {
          const edge: Record<string, unknown> = {};
          for (const sel of field.selection) {
            if (sel.kind !== 'spread' && sel.kind !== 'inline') {
              const edgeField = sel as FieldNode;
              if (edgeField.name === 'node') {
                edge[edgeField.alias ?? 'node'] = executeSelections({ kind: 'pull', repo: scope.repo, pull }, edgeField.selection, ctx);
              } else if (edgeField.name === 'cursor') {
                edge[edgeField.alias ?? 'cursor'] = cursorFor(pull.number);
              }
            }
          }
          return edge;
        });
      case 'pageInfo':
        return executeSelections({ kind: 'page-info', hasNextPage: false, endCursor: null }, field.selection, ctx);
      case 'totalCount':
        return scope.repo.pulls.length;
      default: return unknownField(scope, field, ctx);
    }
  }

  if (scope.kind === 'files-connection') {
    switch (field.name) {
      case 'nodes': {
        const files = rest.pullFiles(scope.repo, scope.pull);
        return files.map((file) => ({ path: file.filename }));
      }
      case 'totalCount':
        return rest.pullFiles(scope.repo, scope.pull).length;
      default: return unknownField(scope, field, ctx);
    }
  }

  if (scope.kind === 'type') {
    switch (field.name) {
      case 'name': return scope.name;
      case 'kind': return scope.name === 'SearchType' ? 'ENUM' : 'OBJECT';
      case 'fields': {
        const names = TYPE_FIELDS[scope.name] ?? [];
        return names.map((name) => ({ name }));
      }
      case 'enumValues': {
        if (scope.name !== 'SearchType') return [];
        return SEARCH_TYPE_VALUES.map((name) => ({ name }));
      }
      default: return unknownField(scope, field, ctx);
    }
  }

  if (scope.kind === 'owner') {
    if (field.name === 'login') return scope.login;
    if (field.name === 'id') return store.viewer.id;
    return unknownField(scope, field, ctx);
  }

  if (scope.kind === 'branch-ref') {
    if (field.name === 'name') return scope.name;
    return unknownField(scope, field, ctx);
  }

  if (scope.kind === 'page-info') {
    if (field.name === 'hasNextPage') return scope.hasNextPage;
    if (field.name === 'endCursor') return scope.endCursor;
    if (field.name === 'hasPreviousPage') return false;
    if (field.name === 'startCursor') return null;
    return unknownField(scope, field, ctx);
  }

  if (scope.kind === 'comment-edge') {
    if (field.name === 'node') return executeSelections({ kind: 'comment-node', id: scope.id, body: scope.body }, field.selection, ctx);
    if (field.name === 'cursor') return cursorFor(0);
    return unknownField(scope, field, ctx);
  }

  if (scope.kind === 'comment-node') {
    if (field.name === 'id') return scope.id;
    if (field.name === 'body') return scope.body;
    return unknownField(scope, field, ctx);
  }

  return unknownField(scope, field, ctx);
}

function executeOperation(operation: OperationNode, ctx: ExecContext): { data: Record<string, unknown>; errors: { message: string }[] } {
  if (operation.operation === 'mutation') {
    return executeMutation(operation, ctx);
  }
  const data = executeSelections({ kind: 'query' }, operation.selection, ctx);
  return { data, errors: ctx.errors };
}

function executeMutation(operation: OperationNode, ctx: ExecContext): { data: Record<string, unknown>; errors: { message: string }[] } {
  const { store, rest } = ctx;
  const data: Record<string, unknown> = {};
  for (const selection of operation.selection) {
    if (selection.kind !== 'spread' && selection.kind !== 'inline') {
      const field = selection as FieldNode;
      const key = field.alias ?? field.name;
      const input = argValue(field, 'input', ctx);
      const inputObj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      if (field.name === 'createIssue') {
        const repositoryId = inputObj.repositoryId;
        const decoded = typeof repositoryId === 'string' ? store.decodeGlobalId(repositoryId) : null;
        const repo = decoded ? store.repoByDatabaseId(decoded.repoId) : undefined;
        const title = typeof inputObj.title === 'string' ? inputObj.title : '';
        const body = typeof inputObj.body === 'string' ? inputObj.body : '';
        const issue = repo && title !== '' ? rest.createIssueObj(repo, title, body, []) : null;
        const issueSel = field.selection.find((sel) => sel.kind !== 'spread' && sel.kind !== 'inline' && (sel as FieldNode).name === 'issue') as FieldNode | undefined;
        data[key] = {
          issue: issue && repo && issueSel
            ? executeSelections({ kind: 'mutation-issue', repo, issue }, issueSel.selection, ctx)
            : null,
        };
        continue;
      }
      if (field.name === 'closeIssue') {
        const issueId = inputObj.issueId;
        const decoded = typeof issueId === 'string' ? store.decodeGlobalId(issueId) : null;
        const repo = decoded ? store.repoByDatabaseId(decoded.repoId) : undefined;
        const issue = repo && decoded ? repo.findIssue(decoded.number) : undefined;
        if (issue) {
          issue.state = 'closed';
          issue.updatedAt = store.clock.tick();
        }
        const issueSel = field.selection.find((sel) => sel.kind !== 'spread' && sel.kind !== 'inline' && (sel as FieldNode).name === 'issue') as FieldNode | undefined;
        data[key] = {
          issue: issue && repo && issueSel
            ? executeSelections({ kind: 'mutation-issue', repo, issue }, issueSel.selection, ctx)
            : null,
        };
        continue;
      }
      if (field.name === 'createPullRequest') {
        const repositoryId = inputObj.repositoryId;
        const decoded = typeof repositoryId === 'string' ? store.decodeGlobalId(repositoryId) : null;
        const repo = decoded ? store.repoByDatabaseId(decoded.repoId) : undefined;
        const head = typeof inputObj.headRefName === 'string' ? inputObj.headRefName : '';
        const base = typeof inputObj.baseRefName === 'string' ? inputObj.baseRefName : '';
        const title = typeof inputObj.title === 'string' ? inputObj.title : '';
        const body = typeof inputObj.body === 'string' ? inputObj.body : '';
        const pull = repo && head !== '' && base !== '' && title !== '' ? rest.createPullObj(repo, head, base, title, body) : null;
        const pullSel = field.selection.find((sel) => sel.kind !== 'spread' && sel.kind !== 'inline' && (sel as FieldNode).name === 'pullRequest') as FieldNode | undefined;
        data[key] = {
          pullRequest: pull && repo && pullSel
            ? executeSelections({ kind: 'mutation-pull', repo, pull }, pullSel.selection, ctx)
            : null,
        };
        continue;
      }
      if (field.name === 'mergePullRequest') {
        const pullRequestId = inputObj.pullRequestId;
        const decoded = typeof pullRequestId === 'string' ? store.decodeGlobalId(pullRequestId) : null;
        const repo = decoded ? store.repoByDatabaseId(decoded.repoId) : undefined;
        const pull = repo && decoded ? repo.findPull(decoded.number) : undefined;
        if (pull && repo) rest.mergePullObj(repo, pull);
        const pullSel = field.selection.find((sel) => sel.kind !== 'spread' && sel.kind !== 'inline' && (sel as FieldNode).name === 'pullRequest') as FieldNode | undefined;
        data[key] = {
          pullRequest: pull && repo && pullSel
            ? executeSelections({ kind: 'mutation-pull', repo, pull }, pullSel.selection, ctx)
            : null,
        };
        continue;
      }
      if (field.name === 'addComment') {
        const subjectId = inputObj.subjectId;
        const decoded = typeof subjectId === 'string' ? store.decodeGlobalId(subjectId) : null;
        const repo = decoded ? store.repoByDatabaseId(decoded.repoId) : undefined;
        const issue = repo && decoded ? repo.findIssue(decoded.number) : undefined;
        const body = typeof inputObj.body === 'string' ? inputObj.body : '';
        const comment = issue && repo && body !== '' ? rest.addCommentObj(repo, issue, body) : null;
        const edgeSel = field.selection.find((sel) => sel.kind !== 'spread' && sel.kind !== 'inline' && (sel as FieldNode).name === 'commentEdge') as FieldNode | undefined;
        let edge: Record<string, unknown> | null = null;
        if (comment && repo && issue && edgeSel) {
          const nodeSel = edgeSel.selection.find((sel) => sel.kind !== 'spread' && sel.kind !== 'inline' && (sel as FieldNode).name === 'node') as FieldNode | undefined;
          edge = {
            node: nodeSel
              ? executeSelections({ kind: 'comment-node', id: store.commentGlobalId(repo, issue, comment.id), body: comment.body }, nodeSel.selection, ctx)
              : null,
          };
        }
        data[key] = { commentEdge: edge };
        continue;
      }
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
      data[key] = null;
    }
  }
  return { data, errors: ctx.errors };
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

export interface GraphQLResponse {
  status: number;
  body: Buffer;
}

export function handleGraphQL(store: Store, rest: RestHandler, bodyText: string): GraphQLResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: Buffer.from(JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] }), 'utf8') };
  }
  const operations: { query?: unknown; variables?: unknown; operationName?: unknown }[] = Array.isArray(parsed)
    ? (parsed as Record<string, unknown>[])
    : [parsed as Record<string, unknown>];
  const results: Record<string, unknown>[] = [];
  for (const operation of operations) {
    const query = typeof operation.query === 'string' ? operation.query : '';
    const variables = (typeof operation.variables === 'object' && operation.variables !== null
      ? operation.variables
      : {}) as Record<string, unknown>;
    const operationName = typeof operation.operationName === 'string' ? operation.operationName : undefined;
    results.push(executeDocument(store, rest, query, variables, operationName));
  }
  const body = Array.isArray(parsed) ? results : (results[0] as Record<string, unknown>);
  return { status: 200, body: Buffer.from(JSON.stringify(body), 'utf8') };
}

function executeDocument(
  store: Store,
  rest: RestHandler,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): Record<string, unknown> {
  let defs: (OperationNode | FragmentNode)[];
  try {
    defs = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const def of defs) {
    if (def.kind === 'fragment') fragments.set(def.name, def);
    else operations.push(def);
  }
  const operation = operationName !== undefined
    ? operations.find((op) => op.name === operationName)
    : operations[0];
  if (!operation) return { errors: [{ message: `Unknown operation ${operationName ?? ''}` }] };
  const mergedVariables: Record<string, unknown> = { ...operation.variables, ...variables };
  const ctx: ExecContext = { store, rest, variables: mergedVariables, fragments, errors: [] };
  const result = executeOperation(operation, ctx);
  const out: Record<string, unknown> = { data: result.data };
  if (result.errors.length > 0) out.errors = result.errors;
  return out;
}
