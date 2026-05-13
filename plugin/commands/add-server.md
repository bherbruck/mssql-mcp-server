---
description: Add a new MSSQL Server connection to your mssql-mcp-server config
argument-hint: [server-name]
---

You are helping the user add a new MSSQL Server connection to their mssql-mcp-server config file.

## Config file location

The config lives at `$MSSQL_MCP_CONFIG` if that env var is set; otherwise at `~/.config/mssql-mcp-server/config.yaml`.

Resolve the path now with this Bash one-liner:

```bash
node -e "console.log(process.env.MSSQL_MCP_CONFIG || require('path').join(require('os').homedir(), '.config', 'mssql-mcp-server', 'config.yaml'))"
```

If the directory doesn't exist, create it with `mkdir -p`. If the file doesn't exist, you'll be writing a fresh one with sensible defaults.

## Gather the connection details

Use AskUserQuestion to collect the following, one question per missing piece. Skip questions the user already answered via $ARGUMENTS:

1. **Server alias** — short name like `prod`, `analytics`, `local`. This is the `server` argument users pass to tools. If $ARGUMENTS has a value, use it.
2. **Host** — hostname or IP. Examples: `localhost`, `sql-prod.company.com`, `localhost\SQLEXPRESS`.
3. **Port** — default 1433. Ask only if non-standard.
4. **Database** — default database name (users can override per-query).
5. **Auth kind** — `sql` (cross-platform, username + password) or `windows` (integrated auth, Windows host only).
6. **If sql auth:**
   - **Username**
   - **Password storage** — either inline plaintext in the YAML, or an env var name to read at runtime
   - **Password value** or **env var name**
7. **Read-only?** — defaults to `true`. Set `false` only if you want this server to allow INSERT/UPDATE/DELETE via the gated `execute_write` tool.

## Write the config

Read the existing config file (if any) and parse the YAML. Merge in the new server under `servers:`. If this is the first server, also set `default_server:` to its name.

Preserve any existing comments and formatting where possible. If writing fresh, use this template:

```yaml
default_server: <name>

defaults:
  max_rows: 1000
  timeout_ms: 30000
  read_only: true

servers:
  <name>:
    host: <host>
    port: 1433
    database: <database>
    auth:
      kind: sql
      username: <username>
      password_env: <ENV_VAR_NAME>   # or `password: <plaintext>`
    read_only: true
    encrypt: true
    trust_server_certificate: false
```

For Windows auth, replace the `auth:` block with `auth: { kind: windows }` and note that this requires running on Windows (msnodesqlv8 driver).

## Confirm

After writing, show the user:
1. The path you wrote to
2. The new server entry
3. **Important:** They must restart Claude Code (or reconnect the MCP server) for the new connection to be picked up — the MCP server loads config at startup.

If they used `password_env`, remind them to set that env var before restart.
