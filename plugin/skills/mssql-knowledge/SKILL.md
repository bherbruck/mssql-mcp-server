---
name: mssql-knowledge
description: Persist and recall dataset-specific knowledge about the user's SQL Server connections — query recipes, schema rules, cross-server patterns, business logic. Use whenever the user shares a fact about their data, or before answering a question that the user has likely answered before.
---

The mssql-mcp-server exposes a small "notebook" of markdown skill files via four MCP tools:

- `list_skills` — show every saved skill with a preview and mtime
- `read_skill(name)` — return the full markdown of one
- `write_skill(name, content, mode='replace'|'append')` — create or update
- `delete_skill(name)` — remove (confirm with user first)

Files live in a global directory next to the config (typically `~/.config/mssql-mcp-server/skills/`). They survive across sessions and across MCP server restarts.

## When to write a skill

Whenever the user teaches you something that would be useful next session, persist it. Specifically:

- **Cross-server queries**: "To pull orders enriched with warehouse stock, join `prod.dbo.Orders` against `analytics.dbo.InventorySnapshot` on `sku`."
- **Schema rules**: "`Customers.status_id` IS NULL means the row is a soft-deleted shadow — filter it out unless the user asks for archived data."
- **Business logic**: "Widgets where `type = 'B'` are archived after 90 days — they only appear in `WidgetsArchive`, not `Widgets`."
- **Naming conventions**: "Anything in the `stg_` schema is staging; query `prod` schema for stable data."
- **Pitfalls**: "`Orders.created_at` is in UTC; `Orders.local_created_at` is in the store's local timezone — they can differ by up to 14 hours."

Don't capture trivia or one-shot SQL. Save things the user (or future-you) will want to look up *again*.

## How to organize

One file per topic. Use clear short names that compose into a `list_skills` index a future Claude can grep:

- `cross-server-joins.md`
- `widgets.md`
- `orders-pitfalls.md`
- `naming-conventions.md`

Inside each, lead with a `# Heading` so `list_skills` shows a useful preview. Mix prose and SQL fenced blocks.

## When to read a skill

**At the start of any data question**, call `list_skills` first. It's cheap and the previews tell you which files are relevant. Read the ones that look applicable *before* you formulate a query — they often contain the exact join shape, filter, or gotcha you'd otherwise miss.

If the user says something like "remember when we figured out X" or "use the rule we set for Y", call `list_skills` and read the relevant entry.

## Updating

- `mode='replace'` is the default and is fine for small rewrites.
- `mode='append'` is right when adding a new example or note to an existing topic without disturbing the rest.
- If you find an error in a skill, rewrite it — the user trusts these to be accurate.

## A worked example

User: "Btw, only count widgets where `status_code IN ('A','S')` — that's our 'live' set."

You: call `list_skills`. If a `widgets.md` exists, `read_skill('widgets')`, then `write_skill('widgets', updated_content, mode='replace')` with the new rule added. If not, `write_skill('widgets', '# Widgets\n\n## Live set\n\nA widget is "live" when `status_code IN (\\'A\\',\\'S\\')`. ...', 'replace')`.

Confirm to the user briefly that you've saved the note — one sentence — so they know future sessions will remember.
