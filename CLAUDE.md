# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — TypeScript compile to `dist/` (uses `tsconfig.json`; `test/` excluded from build).
- `npm run dev` — Run the server from source via `tsx` (no build step).
- `npm test` — Vitest single run. Tests are entirely offline; they use `StubExecutor` and require no SQL Server.
- `npm run test:watch` — Vitest watch mode.
- Single test: `npx vitest run test/tools.test.ts` or filter with `-t '<name pattern>'`.
- `npm start -- --config ./config.yaml` — Run the built server. Config path can also come from `MSSQL_MCP_CONFIG` env var; defaults to `./config.yaml`.
- `npm run build:plugin` — Bundles `src/index.ts` with esbuild and zips `plugin/` into `dist/plugin/mssql-mcp-server.plugin` (Cowork/Claude plugin format). The native `msnodesqlv8` module is marked external.

## Architecture

The server is an MCP stdio server exposing 12 tools over a thin `Executor` abstraction. The seam between tool logic and the database is intentional and load-bearing.

### Layering

1. `src/index.ts` — Bootstraps `McpServer`, builds the `MssqlExecutor` and tool list, registers each tool with the MCP SDK, wires `StdioServerTransport`. Tool handlers are wrapped here so any thrown `McpToolError` is converted into an MCP error envelope (`{ isError: true, content: [...] }`).
2. `src/tools.ts` — All 12 tool implementations. Each tool: resolves a target server via `executor.resolve(name)`, composes SQL (mostly against `sys.*` catalog views), calls `executor.exec()`, returns a tight JSON shape. New tools should follow the same pattern and be appended to the array returned by `buildTools()`.
3. `src/executor.ts` — The `Executor` interface that tools depend on. Two implementations: `MssqlExecutor` (runtime, in `pool.ts`) and `StubExecutor` (tests, in `test/stub-driver.ts`). **Tools must not import `mssql` directly** — go through the executor.
4. `src/pool.ts` — `MssqlExecutor` keeps one lazy `mssql.ConnectionPool` per configured server. Per-request `requestTimeout` is set via a runtime cast (the property isn't in `@types/mssql`). The optional `database` ExecOpt is implemented by prefixing the query with `USE [db];` rather than reconnecting.
5. `src/config.ts` — YAML loader with a zod schema. Auth is a discriminated union (`sql` | `windows`); passwords are read from env vars named by `password_env`. SQL auth uses bundled `tedious`; Windows auth requires the optional `msnodesqlv8` peer install and only works on Windows hosts.
6. `src/format.ts` — `canonicalType()` produces the compact `varchar(50)` / `decimal(18,2)` strings exposed to the client. `normalizeRow()` converts `Date → ISO string`, `Buffer → base64`, `bigint → string`, `undefined → null`. Anything new returned to the LLM should go through here.
7. `src/errors.ts` — `McpToolError` plus `toToolError()`, which maps driver errors (numbers like 208, 207, 102; codes like `ETIMEOUT`, `ELOGIN`) to a fixed `ErrorCode` union. Add new mappings here when introducing tools that surface new failure modes.

### Test strategy

`test/stub-driver.ts` provides `StubExecutor` with a `.on(matcher, respond)` API. Tests register pattern → response handlers and assert on tool output shape. **When a new tool runs new SQL,** add matching stub handlers in `freshStub()` (`test/tools.test.ts`) or the test will throw `SYNTAX_ERROR: Stub has no handler for SQL: ...`.

### Read-only model

The server does **not** parse SQL to enforce read-only. Three layers:
1. The SQL login's permissions (the only one that prevents writes at the engine).
2. `execute_write` is disabled unless the target server has `read_only: false` *and* a `confirm_token = sha256(sql.trim())` is supplied. Both gates must pass.
3. Per-server config isolation.

`query` is unguarded by design — if you give it a writable login, it'll run writes. Don't add a SQL parser to fix this; fix the login.

### `describe_object` quirk

The handler in `src/tools.ts` issues four separate small queries (meta, columns, pk, indexes) instead of one batch with multiple result sets. The `Executor` interface returns only the first recordset (`additionalResultSets` is a boolean flag, not the data). If you ever need to consume secondary result sets, extend `ExecResult` rather than working around it ad hoc.

### Plugin packaging

`scripts/build-plugin.mjs` bundles to a single ESM file via esbuild, copies `plugin/` (manifest + skill), syncs the version from `package.json` into `plugin/.claude-plugin/plugin.json`, and zips the result. `release-please` also patches that `plugin.json` version on release PRs (see `release-please-config.json` `extra-files`).

## Conventions

- Conventional Commits drive `release-please` (`fix:` → patch, `feat:` → minor, `feat!:` → major). Other prefixes (`chore`, `docs`, `refactor`) don't bump versions.
- Node ≥ 20. ESM throughout (`"type": "module"`). Local imports use `.js` extensions in TS source (NodeNext-style) — keep this when adding files.
- `noUncheckedIndexedAccess` is on — array/record indexing returns `T | undefined`. Handle the undefined case rather than non-null asserting.
- All identifiers from user input that are interpolated into SQL (schema, table, column names) get `]` doubled and wrapped in `[ ]`. Parameter values always go through `@name` placeholders. Don't break this pattern.
