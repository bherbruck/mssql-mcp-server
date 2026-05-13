---
description: Remove an MSSQL Server connection from your config
argument-hint: [server-name]
---

Help the user remove a server entry from their mssql-mcp-server config.

## Steps

1. **Resolve config path** — `$MSSQL_MCP_CONFIG` or `~/.config/mssql-mcp-server/config.yaml`. If the file doesn't exist, tell the user there's nothing to remove.

2. **Read and parse** the YAML.

3. **Pick which server to remove:**
   - If $ARGUMENTS contains a name and it exists in `servers:`, use that.
   - Otherwise list the configured servers with AskUserQuestion and let the user pick one.

4. **Confirm** with AskUserQuestion before deleting — irreversible from this command's perspective.

5. **Rewrite the YAML** without that server. If the removed server was `default_server`, clear that key (or set it to another server if one remains and the user agrees).

6. **Tell the user** to restart Claude Code so the MCP server reloads the config.
