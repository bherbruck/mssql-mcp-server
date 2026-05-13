# mssql-mcp-server

An MCP server that lets an LLM (Claude, etc.) discover schemas, run queries, and build live dashboards across **one or more** Microsoft SQL Server instances.

Design goals: predictable JSON, multi-server first, easy to install, no parser sitting between Claude and the database. Read-only enforcement is delegated to the SQL login's permissions — keep your read-only logins read-only.

## Install

### As a Claude Code plugin (recommended)

```
/plugin marketplace add bherbruck/mssql-mcp-server
/plugin install mssql-mcp-server
```

Then add your first connection from inside Claude Code:

```
/mssql:add-server
```

Other connector commands:

| Command | What it does |
|---|---|
| `/mssql:add-server [name]` | Wizard: host, db, auth, password. Writes to `~/.config/mssql-mcp-server/config.yaml`. |
| `/mssql:list-servers` | Show every configured connection. |
| `/mssql:remove-server [name]` | Delete a connection. |
| `/mssql:test-connection [name]` | Round-trip check via `get_server_info`. |

Config is hot-reloaded — adding/removing servers is picked up immediately. The only thing that needs a restart is setting a new `password_env` env var, since env vars are inherited at process start.

### Standalone (Claude Desktop, other MCP clients)

Four ways to configure, listed simplest first. Pick whichever fits.

**1. Plain env vars** — single server, no nested JSON, no extra files. Easiest for one-off setups.

```json
{
  "mcpServers": {
    "mssql": {
      "command": "npx",
      "args": ["-y", "github:bherbruck/mssql-mcp-server"],
      "env": {
        "MSSQL_HOST": "sql.example.com",
        "MSSQL_DATABASE": "Sales",
        "MSSQL_USER": "reader",
        "MSSQL_PASSWORD": "hunter2"
      }
    }
  }
}
```

Recognized vars: `MSSQL_HOST`, `MSSQL_DATABASE`, `MSSQL_PORT`, `MSSQL_USER` (or `MSSQL_USERNAME`), `MSSQL_PASSWORD` (or `MSSQL_PASSWORD_ENV` for indirection), `MSSQL_AUTH` (`sql` | `windows`), `MSSQL_NAME` (alias, default `default`), `MSSQL_READ_ONLY`, `MSSQL_ENCRYPT`, `MSSQL_TRUST_SERVER_CERTIFICATE`.

**2. Config file** — multi-server or when you want hot-reload on edits. Default location is `~/.config/mssql-mcp-server/config.yaml`; override with `--config` or `$MSSQL_MCP_CONFIG`. YAML or JSON (JSON is valid YAML 1.2).

```json
{
  "mcpServers": {
    "mssql": {
      "command": "npx",
      "args": ["-y", "github:bherbruck/mssql-mcp-server", "--config", "/abs/path/to/db.json"]
    }
  }
}
```

**3. Full JSON inline via env var** — multi-server without a separate file. No hot reload.

```json
{
  "env": {
    "MSSQL_MCP_CONFIG_JSON": "{\"servers\":{\"prod\":{\"host\":\"...\",\"database\":\"...\",\"auth\":{\"kind\":\"sql\",\"username\":\"...\",\"password\":\"...\"}}}}"
  }
}
```

**4. Full JSON inline via CLI flag** — same content, travels in `args`. Equivalent to option 3.

```json
{
  "args": ["-y", "github:bherbruck/mssql-mcp-server", "--config-json", "{...}"]
}
```

Precedence when multiple are set: `--config-json` → `MSSQL_MCP_CONFIG_JSON` → `MSSQL_HOST` env vars → `--config` file → `$MSSQL_MCP_CONFIG` → default path.

### From source

```bash
git clone https://github.com/bherbruck/mssql-mcp-server
cd mssql-mcp-server
npm install
npm run build
npm test
npm start -- --config ./config.yaml
```

## Configuration

See `config.example.yaml`. The shape:

```yaml
default_server: prod         # optional; if set, tools can omit `server`

defaults:
  max_rows: 1000             # truncation cap for query() unless overridden
  timeout_ms: 30000
  read_only: true            # informational; real enforcement is the SQL login

servers:
  prod:
    host: prod-sql.company.com
    port: 1433
    database: Sales
    auth:
      kind: sql              # sql | windows
      username: claude_reader
      password_env: PROD_SQL_PASSWORD
    encrypt: true
    trust_server_certificate: false
```

**Two auth modes:**

| Mode | When to use | Driver |
|---|---|---|
| `sql` | Anywhere. Cross-platform. SQL Server with a SQL login. | tedious (bundled) |
| `windows` | Windows host, integrated auth. | `msnodesqlv8` (optional peer install) |

For Windows authentication, install the optional driver:

```bash
npm install msnodesqlv8
```

Then in config: `auth: { kind: windows }`. The host must be Windows; `msnodesqlv8` does not work on Mac/Linux.

## Tools

| Tool | Purpose |
|---|---|
| `list_servers` | List configured connections |
| `get_server_info` | Version, current user, default schema |
| `list_databases` | Databases on a server |
| `list_schemas` | Schemas in a database |
| `list_objects` | Tables/views in a schema (with optional LIKE filter) |
| `describe_object` | Columns, primary key, indexes for one table/view |
| `search_objects` | Fuzzy search across table, view, and column names |
| `sample_rows` | Peek at real values (≤50 rows) |
| `column_stats` | Distribution stats for a column |
| `explain_query` | Estimated query plan |
| `query` | Run a SQL statement |
| `execute_write` | Mutations (gated by `read_only: false` + sha256 confirm token) |

All tools accept an optional `server` parameter. The full input/output JSON shapes are in `../mssql-mcp-spec.md` (the design spec this implementation tracks).

## Security model

There are three layers of defense, listed strongest-first:

1. **The SQL login.** Use a login with `SELECT`-only permissions for read-only servers. This is the only layer that actually prevents writes at the engine level.
2. **`execute_write` gate.** Disabled unless `read_only: false` on the target server, and requires a sha256 of the SQL as a confirm token. Prevents accidental destructive calls from typo-prone LLMs.
3. **Configuration boundaries.** Each server has its own credentials and database; nothing is shared across the connection pool.

This server intentionally does **not** parse SQL to enforce read-only — that responsibility lives with the SQL login. Don't deploy with a `db_owner` login and trust the MCP layer.

## Architecture

```
src/
├── index.ts          MCP server bootstrap (stdio transport)
├── config.ts         YAML loader + zod validation
├── executor.ts       Executor interface (the abstraction tools depend on)
├── pool.ts           MssqlExecutor — wraps node-mssql connection pools
├── tools.ts          All 12 tool implementations
├── format.ts         Type canonicalization, row value normalization
└── errors.ts         Error envelope + driver error mapping

test/
├── stub-driver.ts    StubExecutor — in-memory fake for offline tests
├── tools.test.ts     One smoke test per tool
└── format.test.ts    Type/value normalization
```

The `Executor` interface is the seam. Tools depend on it, not on `mssql`. Tests pass a `StubExecutor` that pattern-matches SQL and returns canned data. This is how the test suite runs without a real database.

## Extending

To add a new tool:

1. Add a function inside `buildTools()` in `src/tools.ts`. Define `name`, `description`, an input zod schema, and a handler.
2. Add at least one test in `test/tools.test.ts`. If the tool runs new SQL patterns, register matching stub handlers in `freshStub()`.
3. `npm test` to verify.

To add a new error code, update the `ErrorCode` union in `src/errors.ts` and (if applicable) add a mapping rule in `toToolError()`.

## What this server intentionally doesn't do

- **No SQL parsing.** Trust the login. If you want a parser layer, run `node-sql-parser` or `sqlglot` upstream.
- **No cross-server joins.** Use SQL Server linked servers and target one MCP server per query.
- **No streaming.** Result sets are truncated at `max_rows`. If you need pagination, use T-SQL `OFFSET … FETCH NEXT`.
- **No connection-level write protection.** That's the SQL login's job.

## License

MIT.
