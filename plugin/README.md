# mssql-mcp-server (Cowork plugin)

Query one or more Microsoft SQL Server instances directly from Claude.

## What you get

- 12 tools for schema discovery and parameterized queries — see the [main README](https://github.com/your-org/mssql-mcp-server#tools) for details.
- A built-in skill (`mssql-workflow`) that teaches Claude the discovery → describe → query playbook so it makes fewer wrong tool picks.
- Multi-server support out of the box. Point at prod, staging, and a warehouse from one plugin install.

## Install

1. Click the `.plugin` file in chat to install into Cowork.
2. Create a config file describing your SQL Server connections. Use `config.example.yaml` (bundled with the plugin) as a starting point.
3. Set the environment variable `MSSQL_MCP_CONFIG` to the absolute path of your config file, plus any password env vars referenced by `password_env`:

   ```bash
   export MSSQL_MCP_CONFIG=/Users/you/.mssql/config.yaml
   export PROD_SQL_PASSWORD=...
   ```

   On Windows (PowerShell):
   ```powershell
   [Environment]::SetEnvironmentVariable("MSSQL_MCP_CONFIG", "C:\Users\you\.mssql\config.yaml", "User")
   [Environment]::SetEnvironmentVariable("PROD_SQL_PASSWORD", "...", "User")
   ```

4. Restart Cowork (or your MCP client) so it picks up the env vars.

## Quick test

After install, ask Claude:

> What SQL Server connections do I have? List the tables in the default schema.

Claude should call `list_servers` then `list_objects(schema: "dbo")`.

## Configuration

See `config.example.yaml` bundled in the plugin. Minimal config:

```yaml
default_server: prod
defaults:
  max_rows: 1000
  timeout_ms: 30000
  read_only: true
servers:
  prod:
    host: prod-sql.example.com
    database: Sales
    auth:
      kind: sql
      username: claude_reader
      password_env: PROD_SQL_PASSWORD
```

## Authentication modes

| Mode | When | Notes |
|---|---|---|
| `sql` | Anywhere, cross-platform | Uses tedious (bundled). Recommended for the plugin. |
| `windows` | Windows host with integrated auth | Requires installing `msnodesqlv8` separately. Not bundled — install via npm. |

## Security

**Read-only enforcement comes from your SQL login, not from this plugin.** Use a login with `SELECT`-only permissions for read-only servers. The plugin gates `execute_write` behind a confirm token, but a writable login is still a writable login.

## Source & support

- Repo: <https://github.com/your-org/mssql-mcp-server>
- Spec: see `mssql-mcp-spec.md` in the source repo for the full tool reference.
- License: MIT
