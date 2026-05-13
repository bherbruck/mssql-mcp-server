// Executor interface — the abstraction that tools depend on.
//
// The runtime executor (in pool.ts) wraps node-mssql connection pools.
// The test stub (in test/stub-driver.ts) implements the same interface in
// memory so we can smoke-test the whole tool surface without a database.

import type { ColumnMeta } from './format.js';

export interface ExecOpts {
  database?: string;
  params?: Record<string, unknown>;
  maxRows?: number;
  timeoutMs?: number;
}

export interface ExecResult {
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
  additionalResultSets: boolean;
}

export interface ResolvedServer {
  name: string;
  database: string;
  isDefault: boolean;
  readOnly: boolean;
  host: string;
  description?: string;
  tags?: string[];
}

export interface Executor {
  listServers(): ResolvedServer[];
  resolve(name?: string): ResolvedServer;
  exec(serverName: string, sql: string, opts?: ExecOpts): Promise<ExecResult>;
  shutdown(): Promise<void>;
  // Directory where the skill/notes markdown files live. Tools manage
  // this directory so Claude can persist dataset knowledge across sessions.
  skillsDir(): string;
}
