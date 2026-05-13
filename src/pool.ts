// Runtime Executor implementation backed by node-mssql.
//
// One connection pool per configured server, lazily initialized. Pools are
// reused across tool calls and across MCP requests.

import sql from 'mssql';
import type { AppConfig, ServerConfig } from './config.js';
import { McpToolError, toToolError } from './errors.js';
import { canonicalType, normalizeRow } from './format.js';
import type { ExecOpts, ExecResult, Executor, ResolvedServer } from './executor.js';

export class MssqlExecutor implements Executor {
  private pools = new Map<string, sql.ConnectionPool>();

  constructor(private config: AppConfig) {}

  listServers(): ResolvedServer[] {
    return Object.entries(this.config.servers).map(([name, cfg]) => ({
      name,
      host: cfg.host,
      database: cfg.database,
      readOnly: cfg.read_only ?? this.config.defaults.read_only,
      isDefault: this.config.default_server === name,
    }));
  }

  resolve(name?: string): ResolvedServer {
    const target = name ?? this.config.default_server;
    if (!target) {
      throw new McpToolError(
        'SERVER_REQUIRED',
        'No server specified and no default_server configured.',
        { hint: 'Call list_servers to see available connections, then pass `server` explicitly.' },
      );
    }
    const cfg = this.config.servers[target];
    if (!cfg) {
      throw new McpToolError('SERVER_NOT_FOUND', `Server "${target}" is not configured.`, {
        hint: 'Call list_servers to see available connections.',
      });
    }
    return {
      name: target,
      host: cfg.host,
      database: cfg.database,
      readOnly: cfg.read_only ?? this.config.defaults.read_only,
      isDefault: this.config.default_server === target,
    };
  }

  async exec(serverName: string, query: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const cfg = this.config.servers[serverName];
    if (!cfg) {
      throw new McpToolError('SERVER_NOT_FOUND', `Server "${serverName}" is not configured.`);
    }
    const pool = await this.getPool(serverName, cfg);
    const maxRows = opts.maxRows ?? cfg.max_rows ?? this.config.defaults.max_rows;
    const timeoutMs = opts.timeoutMs ?? cfg.timeout_ms ?? this.config.defaults.timeout_ms;

    const request = pool.request();
    // Per-request timeout override. Not in @types/mssql but supported at runtime.
    (request as unknown as { requestTimeout: number }).requestTimeout = timeoutMs;

    if (opts.params) {
      for (const [name, value] of Object.entries(opts.params)) {
        request.input(name, value as never);
      }
    }

    // Apply a per-statement database context via USE without losing the pool.
    // Note: this is best-effort; some servers reject USE across logins.
    const wrapped = opts.database
      ? `USE [${opts.database.replace(/]/g, ']]')}]; ${query}`
      : query;

    const started = Date.now();
    let result: sql.IResult<Record<string, unknown>>;
    try {
      result = await request.query(wrapped);
    } catch (err) {
      throw toToolError(err);
    }
    const elapsedMs = Date.now() - started;

    const recordsets = result.recordsets as Record<string, unknown>[][];
    const first = recordsets?.[0] ?? [];
    const additionalResultSets = (recordsets?.length ?? 0) > 1;

    // node-mssql v11 attaches column metadata on result.recordset.columns
    const colsMeta = (first as unknown as { columns?: Record<string, sql.IColumnMetadata[string]> })
      .columns ?? {};
    const columns = Object.entries(colsMeta).map(([name, meta]) => ({
      name,
      type: canonicalType(meta as never),
      nullable: (meta as { nullable?: boolean }).nullable ?? true,
    }));

    const truncated = first.length > maxRows;
    const rows = (truncated ? first.slice(0, maxRows) : first).map(normalizeRow);

    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      elapsedMs,
      additionalResultSets,
    };
  }

  async shutdown(): Promise<void> {
    for (const pool of this.pools.values()) {
      try {
        await pool.close();
      } catch {
        // best effort
      }
    }
    this.pools.clear();
  }

  private async getPool(name: string, cfg: ServerConfig): Promise<sql.ConnectionPool> {
    const existing = this.pools.get(name);
    if (existing?.connected) return existing;

    const sqlConfig: sql.config = {
      server: cfg.host,
      port: cfg.port,
      database: cfg.database,
      options: {
        encrypt: cfg.encrypt ?? true,
        trustServerCertificate: cfg.trust_server_certificate ?? false,
      },
      requestTimeout: cfg.timeout_ms ?? this.config.defaults.timeout_ms,
    };

    if (cfg.auth.kind === 'sql') {
      sqlConfig.user = cfg.auth.username;
      const pw = process.env[cfg.auth.password_env];
      if (!pw) {
        throw new McpToolError(
          'CONNECTION_FAILED',
          `Env var ${cfg.auth.password_env} is not set for server "${name}".`,
        );
      }
      sqlConfig.password = pw;
    } else {
      // Windows / integrated auth requires the msnodesqlv8 driver, which is
      // an optional peer install on Windows only. See README for details.
      (sqlConfig as sql.config & { driver?: string }).driver = 'msnodesqlv8';
      sqlConfig.options = {
        ...sqlConfig.options,
        trustedConnection: true,
      } as never;
    }

    try {
      const pool = new sql.ConnectionPool(sqlConfig);
      await pool.connect();
      this.pools.set(name, pool);
      return pool;
    } catch (err) {
      throw toToolError(err);
    }
  }
}
