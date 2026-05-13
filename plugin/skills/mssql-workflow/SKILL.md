---
name: mssql-workflow
description: How to query Microsoft SQL Server through the mssql MCP server. Trigger when the user mentions SQL Server, MSSQL, T-SQL, their data warehouse, or asks to run a query, build a dashboard against the database, list tables, or describe a schema.
---

# Querying SQL Server with the `mssql` MCP server

This plugin exposes 12 tools under the `mssql` server. Follow this discovery → describe → query playbook to use them well.

## Orientation (cheap, do first)

When a session starts and the user mentions their database, run **one** call:

- `list_servers` — see which connections are configured

If multiple servers exist and the user hasn't named one, ask which to use. Otherwise the `default_server` from config is used automatically.

## Finding the right table

Don't guess table names. Use these in order of decreasing certainty:

1. `search_objects(pattern: "<hint>")` — fuzzy search by name across tables, views, and columns. Use when the user gives a plain-language hint ("orders", "customer email").
2. `list_objects(schema: "dbo")` — list all tables/views in a schema with row count estimates.
3. `list_schemas` then `list_databases` — when you don't know what's available at all.

Prefer `search_objects` over `list_objects` once there are more than ~30 tables.

## Understanding the shape

Before writing a query, call:

- `describe_object(name: "Orders")` — returns columns with types, primary key, foreign keys, and indexes. This is **metadata only** — it does not load any rows into your context.

Use the foreign keys to plan joins. Use the indexes to anticipate which `WHERE` clauses will be fast.

If you need to see real values (date formats, enum codes, naming conventions), use:

- `sample_rows(table: "Orders", n: 5)` — caps at 50 server-side.

## Writing the query

Always use **parameterized queries** with `@name` placeholders. Never interpolate user input into SQL.

```
query(
  sql: "SELECT region, SUM(amount) AS revenue FROM dbo.Orders WHERE created_at >= @since GROUP BY region",
  params: { since: "2025-01-01" }
)
```

Push aggregation, filtering, and `TOP` into SQL. Don't pull 100k rows and aggregate client-side.

If a query joins more than two tables, or filters on a column you're not sure is indexed, run `explain_query` first. A scan-vs-seek difference is 50ms vs. 50s.

## Truncation

`query` returns at most `max_rows` rows (default 1000) and sets `truncated: true` if more existed. When you see `truncated: true`:

- If the user wanted "the top N," they already have it — don't fetch more.
- If they wanted the full set, tighten the `WHERE` clause or paginate with `OFFSET 0 ROWS FETCH NEXT 1000 ROWS ONLY` and increment.
- If you only need an aggregate, push it into SQL — don't loop.

## Building a live dashboard

When the user wants a recurring view, build a live artifact. For each chart, write one `query` call. The artifact calls them on every open:

```javascript
const [byRegion, topProducts] = await Promise.all([
  window.cowork.callMcpTool('mcp__mssql__query', {
    sql: 'SELECT region, SUM(amount) AS revenue FROM dbo.Orders WHERE created_at >= @since GROUP BY region',
    params: { since: filters.start }
  }),
  window.cowork.callMcpTool('mcp__mssql__query', {
    sql: 'SELECT TOP 10 p.name, SUM(ol.qty) AS units FROM dbo.OrderLines ol JOIN dbo.Products p ON p.id = ol.product_id WHERE ol.created_at >= @since GROUP BY p.name ORDER BY units DESC',
    params: { since: filters.start }
  })
]);
```

Each call's `rows` is an array of objects ready for Chart.js. The `columns[].type` tells the artifact which formatter to apply.

**Before baking SQL into an artifact**, run each query once in chat to verify the result shape and confirm the indexes are sane.

## Error recovery

When a tool returns an error envelope, the `code` field tells you what to do:

- `OBJECT_NOT_FOUND` → call `search_objects` with the user's hint; the table name is wrong.
- `SYNTAX_ERROR` → the SQL is malformed; the `line` field points to where.
- `TIMEOUT` → narrow the `WHERE`, or call `explain_query` to find a missing index.
- `PERMISSION_DENIED` → the configured login lacks rights; tell the user which permission to add.
- `SERVER_REQUIRED` → multiple servers configured but no default; ask which one.

Never retry blindly. Always read the `hint` field if present.

## Writes

`execute_write` is **disabled by default** and lives behind a `confirm_token` = sha256 of the SQL. Do not call it unless the user explicitly asks to modify data. Even then, read-back the SQL to the user and ask for confirmation in plain language before computing the token.

## Tools at a glance

| Tool | Use when |
|---|---|
| `list_servers` | First call of a session, or user mentions multiple environments |
| `get_server_info` | Need version (e.g., does `STRING_AGG` work?) or current user |
| `list_databases` / `list_schemas` | Exploring an unfamiliar server |
| `list_objects` | Browsing tables in a known schema |
| `describe_object` | Before writing any query that joins or filters |
| `search_objects` | User gave a plain-language hint about a table or column |
| `sample_rows` | Need to see real values before writing the query |
| `column_stats` | Picking default filter ranges for a dashboard |
| `explain_query` | Joining ≥3 tables, or filtering on a non-indexed column |
| `query` | The workhorse — every read |
| `execute_write` | Only when the user explicitly asks to mutate data |
