#!/usr/bin/env node
// Entry point for the MCP server. Loads config, builds the executor and tool
// set, and wires them up to the MCP SDK over stdio.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ZodObject, ZodRawShape } from 'zod';
import { AppConfigSchema, defaultConfigPath, parseConfigText, type AppConfig } from './config.js';
import { MssqlExecutor, type ExecutorSource } from './pool.js';
import { buildTools } from './tools.js';
import { McpToolError } from './errors.js';

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Build a single-server inline config from MSSQL_* env vars. Lets users
// configure a one-off MCP server using natural env-var fields in their MCP
// client's JSON config — no stringified JSON inside a string value.
//
//   MSSQL_HOST          (required to trigger this path)
//   MSSQL_DATABASE      (required)
//   MSSQL_PORT          (optional)
//   MSSQL_USER          (or MSSQL_USERNAME; required for sql auth)
//   MSSQL_PASSWORD      (or MSSQL_PASSWORD_ENV pointing at another env var)
//   MSSQL_AUTH          ('sql' or 'windows'; defaults to 'sql' if user/pass set, else 'windows')
//   MSSQL_NAME          (server alias key; default 'default')
//   MSSQL_READ_ONLY     ('true' / 'false'; default 'true')
//   MSSQL_ENCRYPT       ('true' / 'false'; default 'true')
//   MSSQL_TRUST_SERVER_CERTIFICATE  ('true' / 'false'; default 'false')
function tryEnvVarConfig(): AppConfig | null {
  const host = process.env.MSSQL_HOST;
  const database = process.env.MSSQL_DATABASE;
  if (!host || !database) return null;
  const name = process.env.MSSQL_NAME ?? 'default';
  const user = process.env.MSSQL_USER ?? process.env.MSSQL_USERNAME;
  const password = process.env.MSSQL_PASSWORD;
  const passwordEnv = process.env.MSSQL_PASSWORD_ENV;
  const kind =
    (process.env.MSSQL_AUTH as 'sql' | 'windows' | undefined) ??
    (user || password || passwordEnv ? 'sql' : 'windows');

  const auth =
    kind === 'sql'
      ? { kind: 'sql' as const, username: user ?? '', password, password_env: passwordEnv }
      : { kind: 'windows' as const };

  const port = process.env.MSSQL_PORT ? Number(process.env.MSSQL_PORT) : undefined;
  const readOnly = parseBool(process.env.MSSQL_READ_ONLY, true);
  const encrypt = parseBool(process.env.MSSQL_ENCRYPT, true);
  const trustServerCertificate = parseBool(process.env.MSSQL_TRUST_SERVER_CERTIFICATE, false);

  const config = {
    default_server: name,
    defaults: { max_rows: 1000, timeout_ms: 30_000, read_only: true },
    servers: {
      [name]: {
        host,
        port,
        database,
        auth,
        read_only: readOnly,
        encrypt,
        trust_server_certificate: trustServerCertificate,
      },
    },
  };
  // Run through the zod schema so we get the same validation surface
  // as a file-based config (e.g. positive-int port).
  const parsed = AppConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid MSSQL_* env-var config:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

// Precedence:
//   1. --config-json / MSSQL_MCP_CONFIG_JSON  (full JSON inline)
//   2. MSSQL_HOST + friends                   (single-server via env vars)
//   3. --config / MSSQL_MCP_CONFIG            (file path)
//   4. default file path                      (~/.config/mssql-mcp-server/config.yaml)
function getExecutorSource(): ExecutorSource {
  const inline = getArg('--config-json') ?? process.env.MSSQL_MCP_CONFIG_JSON;
  if (inline) {
    return { kind: 'inline', config: parseConfigText(inline, '--config-json') };
  }
  const envConfig = tryEnvVarConfig();
  if (envConfig) {
    return { kind: 'inline', config: envConfig };
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
