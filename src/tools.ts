// Tool implementations. Each function is pure-ish: it takes an Executor and a
// validated input, and returns a JSON-serializable result. The MCP transport
// (in index.ts) wraps these in registerTool() calls.
//
// All tools are intentionally small. New tools should follow the pattern:
//   1. Resolve the target server
//   2. Compose a small bit of SQL (often against `sys.*` views)
//   3. Run it via executor.exec()
//   4. Return a tight JSON shape

import { z } from 'zod';
import type { Executor } from './executor.js';
import { McpToolError } from './errors.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------- Shared input fragments ----------

const ServerInput = z.object({
  server: z.string().optional().describe('Configured server name. Omit to use default_server.'),
});

const DatabaseInput = ServerInput.extend({
  database: z.string().optional().describe('Database name. Omit to use the server\'s default.'),
});

const ObjectRef = DatabaseInput.extend({
  schema: z.string().default('dbo').describe('Schema name (default: dbo).'),
});

// ---------- Tools ----------

export function buildTools(executor: Executor) {
  return [
    listServers(executor),
    getServerInfo(executor),
    listDatabases(executor),
    listSchemas(executor),
    listObjects(executor),
    describeObject(executor),
    searchObjects(executor),
    sampleRows(executor),
    columnStats(executor),
    explainQuery(executor),
    runQuery(executor),
    executeWrite(executor),
    listSkills(executor),
    readSkill(executor),
    writeSkill(executor),
    deleteSkill(executor),
  ];
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  // Handler always receives raw input; we parse inside the wrapper so
  // zod defaults are applied consistently whether called from MCP or tests.
  handler: (input: unknown) => Promise<unknown>;
}

function tool<S extends z.ZodObject<z.ZodRawShape>>(def: {
  name: string;
  description: string;
  inputSchema: S;
  handler: (input: z.infer<S>) => Promise<unknown>;
}): ToolDef {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema as unknown as z.ZodObject<z.ZodRawShape>,
    handler: async (input: unknown) => {
      const parsed = def.inputSchema.parse(input ?? {});
      return def.handler(parsed);
    },
  };
}

// ---------- list_servers ----------

function listServers(executor: Executor) {
  return tool({
    name: 'list_servers',
    description:
      'List all configured SQL Server connections. Call this first when you do not know what is available.',
    inputSchema: z.object({}).strict(),
    handler: async () => ({
      servers: executor.listServers().map((s) => ({
        name: s.name,
        host: s.host,
        database: s.database,
        read_only: s.readOnly,
        is_default: s.isDefault,
        description: s.description,
        tags: s.tags,
      })),
    }),
  });
}

// ---------- get_server_info ----------

function getServerInfo(executor: Executor) {
  return tool({
    name: 'get_server_info',
    description:
      'Get SQL Server version, current login, current database, default schema. Useful to confirm available T-SQL features.',
    inputSchema: ServerInput.strict(),
    handler: async (input) => {
      const target = executor.resolve(input.server);
      const result = await executor.exec(
        target.name,
        `SELECT
           @@VERSION AS version,
           SERVERPROPERTY('Edition') AS edition,
           SERVERPROPERTY('ProductVersion') AS product_version,
           DB_NAME() AS [database],
           SUSER_SNAME() AS [user],
           SCHEMA_NAME() AS default_schema`,
      );
      const row = result.rows[0] ?? {};
      return {
        server: target.name,
        host: target.host,
        database: row.database ?? target.database,
        user: row.user ?? null,
        default_schema: row.default_schema ?? 'dbo',
        sql_server_version: row.product_version ?? null,
        edition: row.edition ?? null,
        read_only: target.readOnly,
      };
    },
  });
}

// ---------- list_databases ----------

function listDatabases(executor: Executor) {
  return tool({
    name: 'list_databases',
    description: 'List databases on a server visible to the current login.',
    inputSchema: ServerInput.strict(),
    handler: async (input) => {
      const target = executor.resolve(input.server);
      const result = await executor.exec(
        target.name,
        `SELECT
           name,
           CAST(SUM(size) * 8 / 1024 AS int) AS size_mb,
           recovery_model_desc AS recovery_model,
           state_desc AS state
         FROM sys.databases d
         LEFT JOIN sys.master_files mf ON mf.database_id = d.database_id
         WHERE HAS_DBACCESS(d.name) = 1
         GROUP BY d.name, d.recovery_model_desc, d.state_desc
         ORDER BY d.name`,
      );
      return { server: target.name, databases: result.rows };
    },
  });
}

// ---------- list_schemas ----------

function listSchemas(executor: Executor) {
  return tool({
    name: 'list_schemas',
    description: 'List schemas in a database.',
    inputSchema: DatabaseInput.strict(),
    handler: async (input) => {
      const target = executor.resolve(input.server);
      const result = await executor.exec(
        target.name,
        `SELECT s.name, USER_NAME(s.principal_id) AS owner
         FROM sys.schemas s
         WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA','guest')
         ORDER BY s.name`,
        { database: input.database },
      );
      return {
        server: target.name,
        database: input.database ?? target.database,
        schemas: result.rows,
      };
    },
  });
}

// ---------- list_objects ----------

function listObjects(executor: Executor) {
  return tool({
    name: 'list_objects',
    description:
      'List tables and/or views in a schema. Use `pattern` (SQL LIKE) to filter, `kind` to restrict to one object type.',
    inputSchema: ObjectRef.extend({
      kind: z.enum(['table', 'view', 'all']).default('all'),
      pattern: z.string().optional(),
      limit: z.number().int().positive().max(5000).default(500),
    }).strict(),
    handler: async (input) => {
      const target = executor.resolve(input.server);
      const kindFilter =
        input.kind === 'table'
          ? "AND o.type = 'U'"
          : input.kind === 'view'
            ? "AND o.type = 'V'"
            : "AND o.type IN ('U','V')";
      const result = await executor.exec(
        target.name,
        `SELECT TOP (@limit + 1)
           o.name,
           CASE o.type WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' END AS kind,
           ISNULL((
             SELECT SUM(ps.row_count)
             FROM sys.dm_db_partition_stats ps
             WHERE ps.object_id = o.object_id AND ps.index_id IN (0,1)
           ), 0) AS row_count_estimate
         FROM sys.objects o
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         WHERE s.name = @schema
           ${kindFilter}
           ${input.pattern ? 'AND o.name LIKE @pattern' : ''}
         ORDER BY o.name`,
        {
          database: input.database,
          params: {
            schema: input.schema,
            limit: input.limit,
            ...(input.pattern ? { pattern: input.pattern } : {}),
          },
        },
      );
      const truncated = result.rows.length > input.limit;
      const objects = truncated ? result.rows.slice(0, input.limit) : result.rows;
      return {
        server: target.name,
        database: input.database ?? target.database,
        schema: input.schema,
        objects,
        total: objects.length,
        truncated,
      };
    },
  });
}

// ---------- describe_object ----------

function describeObject(executor: Executor) {
  return tool({
    name: 'describe_object',
    description:
      'Full structural info for one table or view: columns, types, primary key, foreign keys, indexes. Prefer this over SELECT * to learn schema.',
    inputSchema: ObjectRef.extend({
      name: z.string().describe('Table or view name.'),
    }).strict(),
    handler: async (input) => {
      const target = executor.resolve(input.server);
      const params = { schema: input.schema, name: input.name };
      const dbOpts = { database: input.database, params };

      const cols = await executor.exec(
        target.name,
        `SELECT
           c.name,
           t.name AS type_name,
           c.max_length, c.precision, c.scale,
           c.is_nullable AS nullable,
           c.is_identity, c.is_computed,
           OBJECT_DEFINITION(c.default_object_id) AS [default]
         FROM sys.columns c
         JOIN sys.objects o ON o.object_id = c.object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.types t ON t.user_type_id = c.user_type_id
         WHERE s.name = @schema AND o.name = @name
         ORDER BY c.column_id`,
        dbOpts,
      );

      if (cols.rows.length === 0) {
        throw new McpToolError(
          'OBJECT_NOT_FOUND',
          `Object "${input.schema}.${input.name}" was not found.`,
          { hint: 'Use search_objects(pattern) to find the correct name.' },
        );
      }

      const meta = await executor.exec(
        target.name,
        `SELECT
           o.name,
           CASE o.type WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' END AS kind,
           ISNULL((
             SELECT SUM(ps.row_count) FROM sys.dm_db_partition_stats ps
             WHERE ps.object_id = o.object_id AND ps.index_id IN (0,1)
           ), 0) AS row_count_estimate,
           CASE WHEN o.type = 'V' THEN OBJECT_DEFINITION(o.object_id) ELSE NULL END AS view_definition
         FROM sys.objects o
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         WHERE s.name = @schema AND o.name = @name`,
        dbOpts,
      );

      const pk = await executor.exec(
        target.name,
        `SELECT c.name AS column_name
         FROM sys.indexes i
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         JOIN sys.objects o ON o.object_id = i.object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         WHERE i.is_primary_key = 1 AND s.name = @schema AND o.name = @name
         ORDER BY ic.key_ordinal`,
        dbOpts,
      );

      // Denormalized index_columns: aggregate per index in JS. Avoids the
      // STUFF/FOR XML PATH idiom which some SQL Server versions/compat levels
      // reject ("Incorrect syntax near 'ORDER'"). Cross-version safe and
      // gives us included_columns separately.
      const indexRows = await executor.exec(
        target.name,
        `SELECT
           i.name AS index_name,
           i.is_unique AS [unique],
           CASE i.type WHEN 1 THEN 1 ELSE 0 END AS clustered,
           i.type_desc AS [type],
           c.name AS column_name,
           ic.is_included_column,
           ic.key_ordinal,
           ic.index_column_id
         FROM sys.indexes i
         JOIN sys.objects o ON o.object_id = i.object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         LEFT JOIN sys.index_columns ic
           ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         LEFT JOIN sys.columns c
           ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE i.type > 0 AND s.name = @schema AND o.name = @name
         ORDER BY i.index_id, ic.is_included_column, ic.key_ordinal, ic.index_column_id`,
        dbOpts,
      );

      // FKs where this table is the parent. One row per (fk, column).
      const fkRows = await executor.exec(
        target.name,
        `SELECT
           fk.name AS fk_name,
           fk.delete_referential_action_desc AS on_delete,
           fk.update_referential_action_desc AS on_update,
           rs.name AS ref_schema,
           ro.name AS ref_table,
           pc.name AS column_name,
           rc.name AS ref_column,
           fkc.constraint_column_id
         FROM sys.foreign_keys fk
         JOIN sys.objects po ON po.object_id = fk.parent_object_id
         JOIN sys.schemas ps ON ps.schema_id = po.schema_id
         JOIN sys.objects ro ON ro.object_id = fk.referenced_object_id
         JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
         WHERE ps.name = @schema AND po.name = @name
         ORDER BY fk.name, fkc.constraint_column_id`,
        dbOpts,
      );

      const m = meta.rows[0] ?? {};
      return {
        server: target.name,
        database: input.database ?? target.database,
        schema: input.schema,
        name: input.name,
        kind: m.kind ?? 'table',
        row_count_estimate: m.row_count_estimate ?? null,
        columns: cols.rows.map((c) => {
          const obj = c as Record<string, unknown>;
          return {
            name: obj.name,
            type: typeName(
              String(obj.type_name ?? 'unknown'),
              obj.max_length as number | null,
              obj.precision as number | null,
              obj.scale as number | null,
            ),
            nullable: !!obj.nullable,
            is_identity: !!obj.is_identity,
            is_computed: !!obj.is_computed,
            default: obj.default ?? null,
          };
        }),
        primary_key: pk.rows.length ? pk.rows.map((r) => (r as { column_name: string }).column_name) : null,
        indexes: aggregateIndexes(indexRows.rows),
        foreign_keys: aggregateForeignKeys(fkRows.rows),
        view_definition: m.view_definition ?? null,
      };
    },
  });
}

interface IndexInfo {
  name: string;
  columns: string[];
  included_columns: string[];
  unique: boolean;
  clustered: boolean;
  type: unknown;
}

function aggregateIndexes(rows: Record<string, unknown>[]): IndexInfo[] {
  const byName = new Map<string, IndexInfo>();
  for (const r of rows) {
    const name = String(r.index_name ?? '');
    let entry = byName.get(name);
    if (!entry) {
      entry = {
        name,
        columns: [],
        included_columns: [],
        unique: !!r.unique,
        clustered: !!r.clustered,
        type: r.type,
      };
      byName.set(name, entry);
    }
    const col = r.column_name;
    if (typeof col === 'string') {
      if (r.is_included_column) entry.included_columns.push(col);
      else entry.columns.push(col);
    }
  }
  return [...byName.values()];
}

interface ForeignKeyInfo {
  name: string;
  columns: string[];
  ref_schema: string;
  ref_table: string;
  ref_columns: string[];
  on_delete: unknown;
  on_update: unknown;
}

function aggregateForeignKeys(rows: Record<string, unknown>[]): ForeignKeyInfo[] {
  const byName = new Map<string, ForeignKeyInfo>();
  for (const r of rows) {
    const name = String(r.fk_name ?? '');
    let entry = byName.get(name);
    if (!entry) {
      entry = {
        name,
        columns: [],
        ref_schema: String(r.ref_schema ?? ''),
        ref_table: String(r.ref_table ?? ''),
        ref_columns: [],
        on_delete: r.on_delete,
        on_update: r.on_update,
      };
      byName.set(name, entry);
    }
    if (typeof r.column_name === 'string') entry.columns.push(r.column_name);
    if (typeof r.ref_column === 'string') entry.ref_columns.push(r.ref_column);
  }
  return [...byName.values()];
}

function typeName(raw: string, maxLength: number | null, precision: number | null, scale: number | null): string {
  const lower = raw.toLowerCase();
  switch (lower) {
    case 'decimal':
    case 'numeric':
      return `${lower}(${precision ?? 18},${scale ?? 0})`;
    case 'varchar':
    case 'char':
    case 'binary':
    case 'varbinary':
      return `${lower}(${maxLength === -1 ? 'max' : maxLength})`;
    case 'nvarchar':
    case 'nchar':
      return `${lower}(${maxLength === -1 ? 'max' : (maxLength ?? 0) / 2})`;
    default:
      return lower;
  }
}

// ---------- search_objects ----------

function searchObjects(executor: Executor) {
  return tool({
    name: 'search_objects',
    description:
      'Fuzzy search across table, view, and column names. Use when there are many objects and you only have a plain-language hint.',
    inputSchema: ServerInput.extend({
      pattern: z.string().describe('Substring or SQL LIKE pattern (case-insensitive).'),
      scope: z.enum(['tables', 'columns', 'all']).default('all'),
      database: z.string().optional(),
      limit: z.number().int().positive().max(1000).default(100),
    }).strict(),
    handler: async (input) => {
      const target = executor.resolve(input.server);
      const like = input.pattern.includes('%') ? input.pattern : `%${input.pattern}%`;
      const queries: string[] = [];
      if (input.scope === 'tables' || input.scope === 'all') {
        queries.push(`
          SELECT TOP (@limit)
            CASE o.type WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' END AS kind,
            DB_NAME() AS [database],
            s.name AS [schema],
            o.name AS [table],
            CAST(NULL AS sysname) AS [column],
            CAST(NULL AS nvarchar(128)) AS [type]
          FROM sys.objects o
          JOIN sys.schemas s ON s.schema_id = o.schema_id
          WHERE o.type IN ('U','V') AND o.name LIKE @pattern`);
      }
      if (input.scope === 'columns' || input.scope === 'all') {
        queries.push(`
          SELECT TOP (@limit)
            'column' AS kind,
            DB_NAME() AS [database],
            s.name AS [schema],
            o.name AS [table],
            c.name AS [column],
            t.name AS [type]
          FROM sys.columns c
          JOIN sys.objects o ON o.object_id = c.object_id
          JOIN sys.schemas s ON s.schema_id = o.schema_id
          JOIN sys.types t ON t.user_type_id = c.user_type_id
          WHERE o.type IN ('U','V') AND c.name LIKE @pattern`);
      }
      const result = await executor.exec(
        target.name,
        queries.join('\nUNION ALL\n') + '\nORDER BY kind, [schema], [table], [column]',
        { database: input.database, params: { pattern: like, limit: input.limit } },
      );
      const truncated = result.rows.length >= input.limit;
      return { matches: result.rows, truncated };
    },
  });
}

// ---------- sample_rows ----------

function sampleRows(executor: Executor) {
  return tool({
    name: 'sample_rows',
    description:
      'Return a handful of rows from a table so you can see real values (date formats, enum codes, naming). Capped at 50.',
    inputSchema: ObjectRef.extend({
      table: z.string(),
      n: z.number().int().positive().max(50).default(5),
      columns: z.array(z.string()).optional(),
    }).strict(),
    handler: async (input) => {
      const target = executor.resolve(input.server);
      const colList = input.columns?.length
        ? input.columns.map((c) => `[${c.replace(/]/g, ']]')}]`).join(', ')
        : '*';
      const result = await executor.exec(
        target.name,
        `SELECT TOP (@n) ${colList} FROM [${input.schema.replace(/]/g, ']]')}].[${input.table.replace(/]/g, ']]')}]`,
        { database: input.database, params: { n: input.n } },
      );
      return {
        server: target.name,
        database: input.database ?? target.database,
        columns: result.columns,
        rows: result.rows,
        row_count: result.rowCount,
        truncated: false,
        elapsed_ms: result.elapsedMs,
      };
    },
  });
}

// ---------- column_stats ----------

function columnStats(executor: Executor) {
  return tool({
    name: 'column_stats',
    description:
      'Distribution stats (count, distinct, nulls, min/max, top values) for one column. Useful when picking default filter ranges for a dashboard.',
    inputSchema: ObjectRef.extend({
      table: z.string(),
      column: z.string(),
      top_n: z.number().int().positive().max(50).default(10),
    }).strict(),
    handler: async (input) => {
      const target = executor.resolve(input.server);
      const qSchema = `[${input.schema.replace(/]/g, ']]')}]`;
      const qTable = `[${input.table.replace(/]/g, ']]')}]`;
      const qCol = `[${input.column.replace(/]/g, ']]')}]`;

      const basic = await executor.exec(
        target.name,
        `SELECT
           COUNT_BIG(*) AS [count],
           COUNT(DISTINCT ${qCol}) AS [distinct],
           SUM(CASE WHEN ${qCol} IS NULL THEN 1 ELSE 0 END) AS nulls,
           MIN(${qCol}) AS [min],
           MAX(${qCol}) AS [max]
         FROM ${qSchema}.${qTable}`,
        { database: input.database },
      );

      const top = await executor.exec(
        target.name,
        `SELECT TOP (@n) ${qCol} AS value, COUNT_BIG(*) AS [count]
         FROM ${qSchema}.${qTable}
         WHERE ${qCol} IS NOT NULL
         GROUP BY ${qCol}
         ORDER BY COUNT_BIG(*) DESC`,
        { database: input.database, params: { n: input.top_n } },
      );

      const b = basic.rows[0] ?? {};
      return {
        count: b.count ?? 0,
        distinct: b.distinct ?? 0,
        nulls: b.nulls ?? 0,
        min: b.min ?? null,
        max: b.max ?? null,
        top_values: top.rows,
      };
    },
  });
}

// ---------- explain_query ----------

function explainQuery(executor: Executor) {
  return tool({
    name: 'explain_query',
    description:
      'Return the estimated query plan for a SELECT as JSON. Use before running a query you are not sure is indexed.',
    inputSchema: DatabaseInput.extend({
      sql: z.string(),
      params: z.record(z.unknown()).optional(),
    }).strict(),
    handler: async (input) => {
      const target = executor.resolve(input.server);
      await executor.exec(target.name, 'SET SHOWPLAN_XML ON', { database: input.database });
      const result = await executor.exec(target.name, input.sql, {
        database: input.database,
        params: input.params,
      });
      await executor.exec(target.name, 'SET SHOWPLAN_XML OFF', { database: input.database });
      return {
        server: target.name,
        database: input.database ?? target.database,
        plan: result.rows[0] ?? null,
      };
    },
  });
}

// ---------- query ----------

function runQuery(executor: Executor) {
  return tool({
    name: 'query',
    description:
      'Run a SQL statement and return rows + columns. Use @name placeholders with `params` — never interpolate user input into SQL.',
    inputSchema: DatabaseInput.extend({
      sql: z.string(),
      params: z.record(z.unknown()).optional(),
      max_rows: z.number().int().positive().max(100_000).optional(),
      timeout_ms: z.number().int().positive().optional(),
    }).strict(),
    handler: async (input) => {
      const target = executor.resolve(input.server);
      const result = await executor.exec(target.name, input.sql, {
        database: input.database,
        params: input.params,
        maxRows: input.max_rows,
        timeoutMs: input.timeout_ms,
      });
      return {
        server: target.name,
        database: input.database ?? target.database,
        columns: result.columns,
        rows: result.rows,
        row_count: result.rowCount,
        truncated: result.truncated,
        elapsed_ms: result.elapsedMs,
        additional_result_sets: result.additionalResultSets,
      };
    },
  });
}

// ---------- execute_write (gated) ----------

function executeWrite(executor: Executor) {
  return tool({
    name: 'execute_write',
    description:
      'Run an INSERT / UPDATE / DELETE / DDL statement. Disabled unless the target server has read_only: false. Requires confirm_token = sha256(trim(sql)) to force deliberate use.',
    inputSchema: DatabaseInput.extend({
      sql: z.string(),
      params: z.record(z.unknown()).optional(),
      confirm_token: z.string().describe('sha256 hex of sql.trim()'),
    }).strict(),
    handler: async (input) => {
      const target = executor.resolve(input.server);
      if (target.readOnly) {
        throw new McpToolError(
          'WRITE_NOT_ENABLED',
          `Server "${target.name}" is configured read_only. Update config to allow writes.`,
        );
      }
      const expected = createHash('sha256').update(input.sql.trim()).digest('hex');
      if (expected !== input.confirm_token) {
        throw new McpToolError(
          'INVALID_CONFIRM_TOKEN',
          'confirm_token does not match sha256(sql.trim()). Recompute and retry.',
          { hint: `Expected: ${expected}` },
        );
      }
      const result = await executor.exec(target.name, input.sql, {
        database: input.database,
        params: input.params,
      });
      return {
        server: target.name,
        database: input.database ?? target.database,
        rows_affected: result.rowCount,
        elapsed_ms: result.elapsedMs,
      };
    },
  });
}

// ---------- skill files (mssql notebook) ----------
//
// A "skill" here is a markdown file living next to the config — knowledge
// the LLM (or the user) wants to keep around across sessions: cross-server
// query recipes, schema notes, business rules ("widgets where type='B' are
// archived after 90 days"), etc. The MCP layer just exposes safe CRUD over
// the directory; structure and content are up to the caller.

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

function ensureSkillsDir(executor: Executor): string {
  const dir = executor.skillsDir();
  if (!dir) {
    throw new McpToolError('INTERNAL_ERROR', 'Skills directory is not configured.');
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveSkillPath(executor: Executor, name: string): string {
  if (!SKILL_NAME_RE.test(name)) {
    throw new McpToolError(
      'PARAM_BIND_ERROR',
      `Invalid skill name "${name}". Use letters, digits, '-' or '_'; up to 63 chars; must start with alphanumeric.`,
    );
  }
  return join(ensureSkillsDir(executor), `${name}.md`);
}

function listSkills(executor: Executor) {
  return tool({
    name: 'list_skills',
    description:
      'List every saved markdown skill (cross-session notes the user/LLM have written about this dataset). Each entry returns name, size, mtime, and the first heading/line as a preview so you can pick which to read.',
    inputSchema: z.object({}).strict(),
    handler: async () => {
      const dir = ensureSkillsDir(executor);
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => {
          const path = join(dir, e.name);
          const stat = statSync(path);
          const name = e.name.replace(/\.md$/, '');
          let preview = '';
          try {
            const head = readFileSync(path, 'utf-8').slice(0, 400);
            const firstLine = head.split('\n').find((l) => l.trim().length > 0) ?? '';
            preview = firstLine.replace(/^#+\s*/, '').slice(0, 160);
          } catch {
            // ignore
          }
          return {
            name,
            size_bytes: stat.size,
            modified_at: stat.mtime.toISOString(),
            preview,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return { dir, skills: entries };
    },
  });
}

function readSkill(executor: Executor) {
  return tool({
    name: 'read_skill',
    description:
      'Return the full markdown contents of one saved skill. Use list_skills first to see what is available.',
    inputSchema: z
      .object({
        name: z.string().describe('Skill name without the .md extension.'),
      })
      .strict(),
    handler: async (input) => {
      const path = resolveSkillPath(executor, input.name);
      if (!existsSync(path)) {
        throw new McpToolError('OBJECT_NOT_FOUND', `Skill "${input.name}" does not exist.`, {
          hint: 'Call list_skills to see existing skills, or write_skill to create one.',
        });
      }
      const content = readFileSync(path, 'utf-8');
      return { name: input.name, path, content };
    },
  });
}

function writeSkill(executor: Executor) {
  return tool({
    name: 'write_skill',
    description:
      'Create or update a markdown skill. Use mode="replace" (default) to overwrite, or mode="append" to add to the end. Persist dataset knowledge here (query recipes, schema rules, business logic the user has shared) so it survives across sessions.',
    inputSchema: z
      .object({
        name: z.string().describe('Skill name without .md. Letters/digits/_/- only.'),
        content: z.string().describe('Markdown body. Should start with a `# Heading` line.'),
        mode: z.enum(['replace', 'append']).default('replace'),
      })
      .strict(),
    handler: async (input) => {
      const path = resolveSkillPath(executor, input.name);
      let final = input.content;
      if (input.mode === 'append' && existsSync(path)) {
        const existing = readFileSync(path, 'utf-8');
        const sep = existing.endsWith('\n') ? '' : '\n';
        final = existing + sep + '\n' + input.content;
      }
      if (!final.endsWith('\n')) final += '\n';
      writeFileSync(path, final, 'utf-8');
      return {
        name: input.name,
        path,
        bytes_written: Buffer.byteLength(final, 'utf-8'),
        mode: input.mode,
      };
    },
  });
}

function deleteSkill(executor: Executor) {
  return tool({
    name: 'delete_skill',
    description: 'Permanently delete a saved skill. Confirm with the user before calling.',
    inputSchema: z.object({ name: z.string() }).strict(),
    handler: async (input) => {
      const path = resolveSkillPath(executor, input.name);
      if (!existsSync(path)) {
        throw new McpToolError('OBJECT_NOT_FOUND', `Skill "${input.name}" does not exist.`);
      }
      unlinkSync(path);
      return { name: input.name, deleted: true };
    },
  });
}
