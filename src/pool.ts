// Runtime Executor implementation backed by node-mssql.
//
// One connection pool per configured server, lazily initialized. The config
// file is watched: when it changes (e.g. /mssql:add-server writes to it),
// any pools whose per-server config differs are closed so the next call
// rebuilds them with fresh credentials. New servers are picked up
// immediately — no MCP restart required.

import sql from 'mssql';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig, type AppConfig, type ServerConfig } from './config.js';
import { McpToolError, toToolError } from './errors.js';
import { canonicalType, normalizeRow } from './format.js';
import type { ExecOpts, ExecResult, Executor, ResolvedServer } from './executor.js';

export class MssqlExecutor implements Executor {
  private pools = new Map<string, sql.ConnectionPool>();
  private config: AppConfig | null = null;
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(private configPath: string) {
    this.reload();
    this.startWatcher();
  }

  skillsDir(): string {
    return join(dirname(this.configPath), 'skills');
  }

  listServers(): ResolvedServer[] {
    if (!this.config) return [];
    return Object.entries(this.config.servers).map(([name, cfg]) => ({
      name,
      host: cfg.host,
      database: cfg.database,
      readOnly: cfg.read_only ?? this.config!.defaults.read_only,
      isDefault: this.config!.default_server === name,
      description: cfg.description,
      tags: cfg.tags,
    }));
  }

  resolve(name?: string): ResolvedServer {
    this.requireConfig();
    const target = name ?? this.config!.default_server;
    if (!target) {
      throw new McpToolError(
        'SERVER_REQUIRED',
        'No server specified and no default_server configured.',
        { hint: 'Call list_servers to see available connections, then pass `server` explicitly.' },
      );
    }
    const cfg = this.config!.servers[target];
    if (!cfg) {
      throw new McpToolError('SERVER_NOT_FOUND', `Server "${target}" is not configured.`, {
        hint: 'Call list_servers to see available connections.',
      });
    }
    return {
      name: target,
      host: cfg.host,
      database: cfg.database,
      readOnly: cfg.read_only ?? this.config!.defaults.read_only,
      isDefault: this.config!.default_server === target,
    };
  }

  async exec(serverName: string, query: string, opts: ExecOpts = {}): Promise<ExecResult> {
    this.requireConfig();
    const cfg = this.config!.servers[serverName];
    if (!cfg) {
      throw new McpToolError('SERVER_NOT_FOUND', `Server "${serverName}" is not configured.`);
    }
    const pool = await this.getPool(serverName, cfg);
    const maxRows = opts.maxRows ?? cfg.max_rows ?? this.config!.defaults.max_rows;
    const timeoutMs = opts.timeoutMs ?? cfg.timeout_ms ?? this.config!.defaults.timeout_ms;

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
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    for (const pool of this.pools.values()) {
      try {
        await pool.close();
      } catch {
        // best effort
      }
    }
    this.pools.clear();
  }

  private requireConfig(): void {
    if (!this.config) {
      throw new McpToolError(
        'SERVER_REQUIRED',
        `No mssql-mcp-server config loaded from ${this.configPath}.`,
        { hint: 'Run /mssql:add-server in Claude Code to create one.' },
      );
    }
  }

  // Re-read the config file. Tolerant of missing/invalid files: keeps the
  // last good config in memory so a typo while saving doesn't kill the server.
  private reload(): void {
    if (!existsSync(this.configPath)) {
      // First-run case (no config yet) — leave this.config null so tools
      // emit a friendly error pointing at /mssql:add-server.
      return;
    }
    let next: AppConfig;
    try {
      next = loadConfig(this.configPath);
    } catch (err) {
      console.error(`mssql-mcp-server: failed to reload config from ${this.configPath}:`, err);
      return;
    }
    const prev = this.config;
    this.config = next;
    if (!prev) return;
    // Invalidate any pool whose per-server config changed (host/port/auth/
    // database). New servers and removed servers are handled automatically:
    // new ones get pools lazily, removed ones stay in the map until their
    // pool is asked for again (and then SERVER_NOT_FOUND fires).
    for (const [name, pool] of this.pools.entries()) {
      const oldCfg = prev.servers[name];
      const newCfg = next.servers[name];
      if (!newCfg || !serverCfgEqual(oldCfg, newCfg)) {
        this.pools.delete(name);
        pool.close().catch(() => {});
      }
    }
  }

  private startWatcher(): void {
    try {
      // Use fs.watch on the directory and filter by basename — watching the
      // file directly fails on editors that rename-on-save (vim, atomic
      // writes from /mssql:add-server's `Write` tool).
      const dir = this.configPath.replace(/[\\/][^\\/]+$/, '') || '.';
      const base = this.configPath.split(/[\\/]/).pop() ?? '';
      this.watcher = watch(dir, { persistent: false }, (_evt, filename) => {
        if (filename && filename !== base) return;
        // Debounce: editors often emit several events per save.
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null;
          this.reload();
        }, 150);
      });
    } catch {
      // Best effort — fs.watch can fail on network mounts. Without a
      // watcher, hot reload is unavailable but the rest of the server
      // still works; users can SIGHUP / restart manually.
    }
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
      requestTimeout: cfg.timeout_ms ?? this.config!.defaults.timeout_ms,
    };

    if (cfg.auth.kind === 'sql') {
      sqlConfig.user = cfg.auth.username;
      const pw = cfg.auth.password ?? (cfg.auth.password_env ? process.env[cfg.auth.password_env] : undefined);
      if (!pw) {
        throw new McpToolError(
          'CONNECTION_FAILED',
          `No password for server "${name}". Set \`password\` in config or export ${cfg.auth.password_env ?? '<password_env>'}.`,
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

function serverCfgEqual(a: ServerConfig | undefined, b: ServerConfig): boolean {
  if (!a) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
