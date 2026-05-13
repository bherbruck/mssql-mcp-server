// Smoke tests for each tool.
//
// We construct a StubExecutor with a small fake database (Sales.dbo.Orders +
// Customers) and verify the JSON shape each tool returns. No SQL Server
// required.

import { describe, it, expect, beforeEach } from 'vitest';
import { StubExecutor } from './stub-driver.js';
import { buildTools } from '../src/tools.js';
import type { ResolvedServer } from '../src/executor.js';

const SERVERS: ResolvedServer[] = [
  { name: 'prod', database: 'Sales', host: 'sql-prod', isDefault: true, readOnly: true },
  { name: 'analytics', database: 'Analytics', host: 'sql-an', isDefault: false, readOnly: true },
];

function freshStub(): StubExecutor {
  const stub = new StubExecutor().servers(SERVERS);

  stub.on(/@@VERSION/i, () => ({
    columns: [{ name: 'version', type: 'nvarchar' }],
    rows: [
      {
        version: 'Microsoft SQL Server 2022 - 16.0.4035.4',
        edition: 'Enterprise Edition',
        product_version: '16.0.4035.4',
        database: 'Sales',
        user: 'claude_reader',
        default_schema: 'dbo',
      },
    ],
  }));

  stub.on(/FROM sys\.databases/i, () => ({
    columns: [
      { name: 'name', type: 'nvarchar' },
      { name: 'size_mb', type: 'int' },
      { name: 'recovery_model', type: 'nvarchar' },
      { name: 'state', type: 'nvarchar' },
    ],
    rows: [
      { name: 'Sales', size_mb: 4096, recovery_model: 'FULL', state: 'ONLINE' },
      { name: 'Inventory', size_mb: 512, recovery_model: 'SIMPLE', state: 'ONLINE' },
    ],
  }));

  stub.on(/FROM sys\.schemas s\s+WHERE s\.name NOT IN/i, () => ({
    columns: [
      { name: 'name', type: 'nvarchar' },
      { name: 'owner', type: 'nvarchar' },
    ],
    rows: [
      { name: 'dbo', owner: 'dbo' },
      { name: 'reporting', owner: 'dbo' },
    ],
  }));

  // list_objects
  stub.on(
    (s) => /FROM sys\.objects o/i.test(s) && /CASE o\.type WHEN 'U'/i.test(s) && !/sys\.columns/i.test(s),
    () => ({
      columns: [
        { name: 'name', type: 'nvarchar' },
        { name: 'kind', type: 'nvarchar' },
        { name: 'row_count_estimate', type: 'bigint' },
      ],
      rows: [
        { name: 'Orders', kind: 'table', row_count_estimate: 1543210 },
        { name: 'Customers', kind: 'table', row_count_estimate: 84021 },
      ],
    }),
  );

  // describe_object: columns query (NOT search_objects which has UNION ALL)
  stub.on(
    (s) => /FROM sys\.columns c\s+JOIN sys\.objects/i.test(s) && !/UNION ALL/i.test(s),
    () => ({
    columns: [
      { name: 'name', type: 'nvarchar' },
      { name: 'type_name', type: 'nvarchar' },
    ],
    rows: [
      {
        name: 'order_id',
        type_name: 'int',
        max_length: 4,
        precision: 10,
        scale: 0,
        nullable: false,
        is_identity: true,
        is_computed: false,
        default: null,
      },
      {
        name: 'customer_id',
        type_name: 'int',
        max_length: 4,
        precision: 10,
        scale: 0,
        nullable: false,
        is_identity: false,
        is_computed: false,
        default: null,
      },
      {
        name: 'amount',
        type_name: 'decimal',
        max_length: 9,
        precision: 12,
        scale: 2,
        nullable: false,
        is_identity: false,
        is_computed: false,
        default: null,
      },
      {
        name: 'region',
        type_name: 'nvarchar',
        max_length: 64,
        precision: 0,
        scale: 0,
        nullable: true,
        is_identity: false,
        is_computed: false,
        default: null,
      },
    ],
  }));

  // describe_object: meta query (objects only, no columns join)
  stub.on(
    (s) => /FROM sys\.objects o/i.test(s) && /view_definition/i.test(s),
    () => ({
      columns: [
        { name: 'name', type: 'nvarchar' },
        { name: 'kind', type: 'nvarchar' },
      ],
      rows: [{ name: 'Orders', kind: 'table', row_count_estimate: 1543210, view_definition: null }],
    }),
  );

  // describe_object: PK columns
  stub.on(/WHERE i\.is_primary_key = 1/i, () => ({
    columns: [{ name: 'column_name', type: 'nvarchar' }],
    rows: [{ column_name: 'order_id' }],
  }));

  // describe_object: indexes
  stub.on(
    (s) => /FROM sys\.indexes i/i.test(s) && /columns_csv/i.test(s),
    () => ({
      columns: [{ name: 'name', type: 'nvarchar' }],
      rows: [
        {
          name: 'PK_Orders',
          unique: true,
          clustered: true,
          type: 'CLUSTERED',
          columns_csv: 'order_id',
        },
        {
          name: 'IX_Orders_Region',
          unique: false,
          clustered: false,
          type: 'NONCLUSTERED',
          columns_csv: 'region',
        },
      ],
    }),
  );

  // search_objects
  stub.on(/LIKE @pattern/i, (_sql, opts) => {
    const p = String(opts.params?.pattern ?? '').toLowerCase();
    const candidates = [
      { kind: 'table', database: 'Sales', schema: 'dbo', table: 'Orders', column: null, type: null },
      { kind: 'table', database: 'Sales', schema: 'dbo', table: 'Customers', column: null, type: null },
      { kind: 'column', database: 'Sales', schema: 'dbo', table: 'Orders', column: 'order_id', type: 'int' },
      { kind: 'column', database: 'Sales', schema: 'dbo', table: 'Customers', column: 'customer_id', type: 'int' },
    ];
    const matches = candidates.filter((c) => {
      const hay = (c.column ?? c.table).toLowerCase();
      const needle = p.replace(/%/g, '');
      return hay.includes(needle);
    });
    return {
      columns: [
        { name: 'kind', type: 'nvarchar' },
        { name: 'database', type: 'nvarchar' },
        { name: 'schema', type: 'nvarchar' },
        { name: 'table', type: 'nvarchar' },
        { name: 'column', type: 'nvarchar' },
        { name: 'type', type: 'nvarchar' },
      ],
      rows: matches,
    };
  });

  // sample_rows: SELECT TOP (@n) ... FROM [schema].[table]
  // (Exclude column_stats top query which also uses TOP (@n) but has GROUP BY)
  stub.on(
    (s) =>
      /^SELECT TOP \(@n\)/i.test(s.trim()) &&
      /FROM \[/i.test(s) &&
      !/GROUP BY/i.test(s),
    (_sql, opts) => {
      const n = Number(opts.params?.n ?? 5);
      const rows = [];
      for (let i = 1; i <= n; i++) {
        rows.push({
          order_id: i,
          customer_id: 100 + i,
          amount: 99.5 * i,
          region: i % 2 ? 'AMER' : 'EMEA',
        });
      }
      return {
        columns: [
          { name: 'order_id', type: 'int', nullable: false },
          { name: 'customer_id', type: 'int', nullable: false },
          { name: 'amount', type: 'decimal(12,2)', nullable: false },
          { name: 'region', type: 'nvarchar(64)', nullable: true },
        ],
        rows,
      };
    },
  );

  // column_stats basic
  stub.on(/COUNT\(DISTINCT/i, () => ({
    columns: [
      { name: 'count', type: 'bigint' },
      { name: 'distinct', type: 'int' },
      { name: 'nulls', type: 'int' },
      { name: 'min', type: 'nvarchar' },
      { name: 'max', type: 'nvarchar' },
    ],
    rows: [{ count: 1543210, distinct: 3, nulls: 12, min: 'AMER', max: 'EMEA' }],
  }));

  // column_stats top values
  stub.on(/ORDER BY COUNT_BIG/i, () => ({
    columns: [
      { name: 'value', type: 'nvarchar' },
      { name: 'count', type: 'bigint' },
    ],
    rows: [
      { value: 'EMEA', count: 612001 },
      { value: 'AMER', count: 503118 },
      { value: 'APAC', count: 318220 },
    ],
  }));

  // arbitrary user query path (for runQuery test)
  stub.on(/^SELECT region, SUM/i, () => ({
    columns: [
      { name: 'region', type: 'nvarchar(64)', nullable: true },
      { name: 'revenue', type: 'decimal(38,2)', nullable: true },
    ],
    rows: [
      { region: 'EMEA', revenue: 4128443.1 },
      { region: 'AMER', revenue: 3812007.55 },
      { region: 'APAC', revenue: 1980232.0 },
    ],
  }));

  return stub;
}

function getTool(stub: StubExecutor, name: string) {
  const tools = buildTools(stub);
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`No tool: ${name}`);
  return t;
}

describe('list_servers', () => {
  it('returns configured connections with is_default flag', async () => {
    const stub = freshStub();
    const t = getTool(stub, 'list_servers');
    const r = (await t.handler({})) as { servers: Array<Record<string, unknown>> };
    expect(r.servers).toHaveLength(2);
    expect(r.servers[0]?.name).toBe('prod');
    expect(r.servers[0]?.is_default).toBe(true);
    expect(r.servers[1]?.is_default).toBe(false);
  });
});

describe('get_server_info', () => {
  it('returns version, edition, user', async () => {
    const stub = freshStub();
    const t = getTool(stub, 'get_server_info');
    const r = (await t.handler({})) as Record<string, unknown>;
    expect(r.server).toBe('prod');
    expect(r.user).toBe('claude_reader');
    expect(r.sql_server_version).toBe('16.0.4035.4');
    expect(r.read_only).toBe(true);
  });

  it('honors explicit server', async () => {
    const stub = freshStub();
    const t = getTool(stub, 'get_server_info');
    const r = (await t.handler({ server: 'analytics' })) as Record<string, unknown>;
    expect(r.server).toBe('analytics');
  });

  it('errors when server is unknown', async () => {
    const stub = freshStub();
    const t = getTool(stub, 'get_server_info');
    await expect(t.handler({ server: 'nope' })).rejects.toMatchObject({ code: 'SERVER_NOT_FOUND' });
  });
});

describe('list_databases', () => {
  it('returns database list', async () => {
    const stub = freshStub();
    const t = getTool(stub, 'list_databases');
    const r = (await t.handler({})) as { databases: Array<Record<string, unknown>> };
    expect(r.databases).toHaveLength(2);
    expect(r.databases[0]?.name).toBe('Sales');
  });
});

describe('list_schemas', () => {
  it('returns schema list', async () => {
    const stub = freshStub();
    const t = getTool(stub, 'list_schemas');
    const r = (await t.handler({})) as { schemas: Array<Record<string, unknown>> };
    expect(r.schemas.map((s) => s.name)).toEqual(['dbo', 'reporting']);
  });
});

describe('list_objects', () => {
  it('lists tables in dbo with row count estimates', async () => {
    const stub = freshStub();
    const t = getTool(stub, 'list_objects');
    const r = (await t.handler({})) as {
      objects: Array<Record<string, unknown>>;
      schema: string;
      truncated: boolean;
    };
    expect(r.schema).toBe('dbo');
    expect(r.objects).toHaveLength(2);
    expect(r.objects[0]?.kind).toBe('table');
    expect(r.objects[0]?.row_count_estimate).toBe(1543210);
    expect(r.truncated).toBe(false);
  });
});

describe('describe_object', () => {
  it('returns columns, primary key, and indexes', async () => {
    const stub = freshStub();
    const t = getTool(stub, 'describe_object');
    const r = (await t.handler({ name: 'Orders' })) as Record<string, unknown>;
    expect(r.kind).toBe('table');
    const cols = r.columns as Array<Record<string, unknown>>;
    expect(cols).toHaveLength(4);
    expect(cols[0]?.name).toBe('order_id');
    expect(cols[0]?.type).toBe('int');
    expect(cols[2]?.type).toBe('decimal(12,2)');
    expect(cols[3]?.type).toBe('nvarchar(32)'); // 64 bytes / 2 = 32 chars
    expect(r.primary_key).toEqual(['order_id']);
    const indexes = r.indexes as Array<Record<string, unknown>>;
    expect(indexes).toHaveLength(2);
    expect(indexes[0]?.columns).toEqual(['order_id']);
  });

  it('errors when object is missing', async () => {
    const stub = new StubExecutor().servers(SERVERS);
    // No handler matches → describe_object will throw OBJECT_NOT_FOUND (cols.rows empty)
    // Provide a column handler returning empty
    stub.on(/FROM sys\.columns c/i, () => ({ rows: [] }));
    const t = getTool(stub, 'describe_object');
    await expect(t.handler({ name: 'Missing' })).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' });
  });
});

describe('search_objects', () => {
  it('finds tables by substring', async () => {
    const stub = freshStub();
    const t = getTool(stub, 'search_objects');
    const r = (await t.handler({ pattern: 'order' })) as { matches: Array<Record<string, unknown>> };
    const names = r.matches.map((m) => `${m.kind}:${m.table}.${m.column ?? ''}`);
    expect(names).toContain('table:Orders.');
    expect(names).toContain('column:Orders.order_id');
  });
});

describe('sample_rows', () => {
  it('returns N rows', async () => {
    const stub = freshStub();
    const t = getTool(stub, 'sample_rows');
    const r = (await t.handler({ table: 'Orders', n: 3 })) as {
      rows: Array<Record<string, unknown>>;
      columns: Array<Record<string, unknown>>;
    };
    expect(r.rows).toHaveLength(3);
    expect(r.columns.map((c) => c.name)).toEqual(['order_id', 'customer_id', 'amount', 'region']);
  });
});

describe('column_stats', () => {
  it('returns basic distribution + top values', async () => {
    const stub = freshStub();
    const t = getTool(stub, 'column_stats');
    const r = (await t.handler({ table: 'Orders', column: 'region' })) as Record<string, unknown>;
    expect(r.count).toBe(1543210);
    expect(r.distinct).toBe(3);
    expect((r.top_values as Array<Record<string, unknown>>)[0]?.value).toBe('EMEA');
  });
});

describe('query', () => {
  it('passes SQL through and returns columns + rows', async () => {
    const stub = freshStub();
    const t = getTool(stub, 'query');
    const r = (await t.handler({
      sql: 'SELECT region, SUM(amount) AS revenue FROM dbo.Orders WHERE created_at >= @since GROUP BY region',
      params: { since: '2025-01-01' },
    })) as Record<string, unknown>;
    expect(r.server).toBe('prod');
    expect((r.rows as unknown[]).length).toBe(3);
    expect((r.columns as Array<Record<string, unknown>>)[0]?.name).toBe('region');
  });

  it('records that params were passed to executor', async () => {
    const stub = freshStub();
    const t = getTool(stub, 'query');
    await t.handler({
      sql: 'SELECT region, SUM(amount) AS revenue FROM dbo.Orders WHERE created_at >= @since GROUP BY region',
      params: { since: '2025-01-01' },
    });
    const lastCall = stub.calls[stub.calls.length - 1];
    expect(lastCall?.opts.params).toEqual({ since: '2025-01-01' });
  });
});

describe('execute_write', () => {
  it('refuses on read-only servers', async () => {
    const stub = freshStub();
    const t = getTool(stub, 'execute_write');
    await expect(
      t.handler({
        sql: 'DELETE FROM dbo.Orders WHERE 1=0',
        confirm_token: 'whatever',
      }),
    ).rejects.toMatchObject({ code: 'WRITE_NOT_ENABLED' });
  });

  it('accepts on writable server with valid token', async () => {
    const stub = new StubExecutor().servers([
      { name: 'scratch', database: 'Sandbox', host: 'localhost', isDefault: true, readOnly: false },
    ]);
    stub.on(/UPDATE/i, () => ({ rows: [] }));
    const t = getTool(stub, 'execute_write');
    const sql = 'UPDATE dbo.Toggle SET enabled = 1 WHERE id = 5';
    const { createHash } = await import('node:crypto');
    const token = createHash('sha256').update(sql.trim()).digest('hex');
    const r = (await t.handler({ sql, confirm_token: token })) as Record<string, unknown>;
    expect(r.server).toBe('scratch');
    expect(r.rows_affected).toBe(0);
  });

  it('rejects bad confirm_token', async () => {
    const stub = new StubExecutor().servers([
      { name: 'scratch', database: 'Sandbox', host: 'localhost', isDefault: true, readOnly: false },
    ]);
    stub.on(/UPDATE/i, () => ({ rows: [] }));
    const t = getTool(stub, 'execute_write');
    await expect(
      t.handler({
        sql: 'UPDATE dbo.Toggle SET enabled = 1',
        confirm_token: 'wrong',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIRM_TOKEN' });
  });
});

describe('truncation', () => {
  it('marks results truncated when row count exceeds max_rows', async () => {
    const stub = new StubExecutor().servers(SERVERS);
    const bigRows = Array.from({ length: 1500 }, (_, i) => ({ id: i, name: `n${i}` }));
    stub.on(/.*/, () => ({
      columns: [
        { name: 'id', type: 'int' },
        { name: 'name', type: 'nvarchar' },
      ],
      rows: bigRows,
    }));
    const t = getTool(stub, 'query');
    const r = (await t.handler({ sql: 'SELECT * FROM big', max_rows: 1000 })) as Record<string, unknown>;
    expect(r.truncated).toBe(true);
    expect((r.rows as unknown[]).length).toBe(1000);
  });
});
