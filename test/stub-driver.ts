// In-memory stub of the Executor used for smoke tests.
//
// You configure servers and pattern → response handlers, then hand the stub
// to buildTools() in place of MssqlExecutor. All tests run offline.

import type { ExecOpts, ExecResult, Executor, ResolvedServer } from '../src/executor.js';
import { McpToolError } from '../src/errors.js';

export interface StubResponse {
  columns?: { name: string; type: string; nullable?: boolean }[];
  rows: Record<string, unknown>[];
  additionalResultSets?: boolean;
}

type Matcher = RegExp | ((sql: string) => boolean);

export class StubExecutor implements Executor {
  private servers_: ResolvedServer[] = [];
  private defaultServer_?: string;
  private handlers: Array<{ match: Matcher; respond: (sql: string, opts: ExecOpts) => StubResponse }> = [];
  public calls: Array<{ server: string; sql: string; opts: ExecOpts }> = [];
  private skillsDir_ = '';

  skillsDir(): string {
    return this.skillsDir_;
  }

  setSkillsDir(dir: string): this {
    this.skillsDir_ = dir;
    return this;
  }

  servers(list: ResolvedServer[]): this {
    this.servers_ = list;
    this.defaultServer_ = list.find((s) => s.isDefault)?.name;
    return this;
  }

  on(match: Matcher, respond: (sql: string, opts: ExecOpts) => StubResponse): this {
    this.handlers.push({ match, respond });
    return this;
  }

  listServers(): ResolvedServer[] {
    return this.servers_;
  }

  resolve(name?: string): ResolvedServer {
    const target = name ?? this.defaultServer_;
    if (!target) {
      throw new McpToolError('SERVER_REQUIRED', 'No server specified and no default.');
    }
    const found = this.servers_.find((s) => s.name === target);
    if (!found) {
      throw new McpToolError('SERVER_NOT_FOUND', `Server "${target}" not configured.`);
    }
    return found;
  }

  async exec(server: string, sql: string, opts: ExecOpts = {}): Promise<ExecResult> {
    this.calls.push({ server, sql, opts });
    for (const h of this.handlers) {
      const matches = h.match instanceof RegExp ? h.match.test(sql) : h.match(sql);
      if (matches) {
        const r = h.respond(sql, opts);
        const maxRows = opts.maxRows ?? 1000;
        const truncated = r.rows.length > maxRows;
        const rows = truncated ? r.rows.slice(0, maxRows) : r.rows;
        return {
          columns: (r.columns ?? []).map((c) => ({
            name: c.name,
            type: c.type,
            nullable: c.nullable ?? true,
          })),
          rows,
          rowCount: rows.length,
          truncated,
          elapsedMs: 1,
          additionalResultSets: !!r.additionalResultSets,
        };
      }
    }
    throw new McpToolError(
      'SYNTAX_ERROR',
      `Stub has no handler for SQL: ${sql.substring(0, 100).replace(/\s+/g, ' ').trim()}`,
    );
  }

  async shutdown(): Promise<void> {
    // noop
  }
}
