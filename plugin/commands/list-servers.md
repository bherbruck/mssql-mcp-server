---
description: Show all configured MSSQL Server connections
---

Show the user every server configured in their mssql-mcp-server config file.

Two sources of truth:
1. **Live (preferred):** if the `mssql` MCP server is connected, call its `list_servers` tool. This reflects exactly what the server is using.
2. **File:** read the config YAML directly (path from `$MSSQL_MCP_CONFIG` or `~/.config/mssql-mcp-server/config.yaml`).

Use the file fallback only if the MCP tool isn't available — e.g. when the server failed to start because the config was missing.

Display as a compact table with columns: `name`, `host`, `database`, `auth`, `read_only`, `default`. Mark the default server with a `*` next to its name.

If no servers are configured, suggest running `/mssql:add-server`.
