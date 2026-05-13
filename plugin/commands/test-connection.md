---
description: Test that a configured MSSQL Server connection is reachable
argument-hint: [server-name]
---

Verify a server in the mssql-mcp-server config can actually be reached.

## Steps

1. **Pick a server.** If $ARGUMENTS has a name, use it. Otherwise call the `list_servers` tool, then ask the user which one to test (or default to the one marked `is_default: true`).

2. **Call `get_server_info`** on that server. This is the cheapest round-trip — it returns the SQL Server version, current login, and default schema.

3. **On success**, show the user:
   - server name + host
   - SQL Server edition / version
   - login that connected
   - default schema
   - read-only flag

4. **On failure**, surface the error code and message verbatim, then suggest:
   - `CONNECTION_FAILED` → check host/port/firewall, env var for password
   - `PERMISSION_DENIED` → the login can connect but doesn't have `VIEW SERVER STATE` — usually fine, try `list_databases` instead
   - any other → check `list_servers` matches what's in the YAML; the MCP server may need restarting to pick up config changes
