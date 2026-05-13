#!/usr/bin/env node
// Entry point for the MCP server. Loads config, builds the executor and tool
// set, and wires them up to the MCP SDK over stdio.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ZodObject, ZodRawShape } from 'zod';
import { defaultConfigPath, parseConfigText } from './config.js';
import { MssqlExecutor, type ExecutorSource } from './pool.js';
import { buildTools } from './tools.js';
import { McpToolError } from './errors.js';

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Inline (zero-file) setup: pass the entire config as JSON via `--config-json
// '<json>'` or the MSSQL_MCP_CONFIG_JSON env var. Useful for one-off MCP
// installs where the user wants everything in their MCP client config and no
// extra file on disk.
function getExecutorSource(): ExecutorSource {
  const inlineArg = getArg('--config-json');
  const inlineEnv = process.env.MSSQL_MCP_CONFIG_JSON;
  const inline = inlineArg ?? inlineEnv;
  if (inline) {
    return { kind: 'inline', config: parseConfigText(inline, '--config-json') };
  }
  const path = getArg('--config') ?? process.env.MSSQL_MCP_CONFIG ?? defaultConfigPath();
  return { kind: 'file', path };
}

export async function main(): Promise<void> {
  const executor = new MssqlExecutor(getExecutorSource());
  const tools = buildTools(executor);

  const server = new McpServer({
    name: 'mssql-mcp-server',
    version: '0.1.0',
  });

  for (const t of tools) {
    const shape = (t.inputSchema as unknown as ZodObject<ZodRawShape>).shape;
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: shape,
      },
      async (input: unknown) => {
        try {
          const result = await t.handler(input as never);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (err) {
          const wrapped =
            err instanceof McpToolError
              ? err
              : new McpToolError('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(wrapped.toJSON(), null, 2) }],
          };
        }
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    try {
      await executor.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
