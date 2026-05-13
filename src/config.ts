import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// Either `password` (plaintext) or `password_env` (env var name) must be set
// for kind: sql. We don't enforce that here so the discriminated union stays
// a plain ZodObject set — the missing-password case is reported at connect
// time in pool.ts with a more actionable error.
const AuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('windows') }),
  z.object({
    kind: z.literal('sql'),
    username: z.string(),
    password: z.string().optional(),
    password_env: z.string().optional(),
  }),
]);

const ServerSchema = z.object({
  host: z.string(),
  port: z.number().int().positive().optional(),
  database: z.string(),
  auth: AuthSchema,
  read_only: z.boolean().optional(),
  max_rows: z.number().int().positive().optional(),
  timeout_ms: z.number().int().positive().optional(),
  encrypt: z.boolean().optional(),
  trust_server_certificate: z.boolean().optional(),
});

const DefaultsSchema = z
  .object({
    max_rows: z.number().int().positive().default(1000),
    timeout_ms: z.number().int().positive().default(30_000),
    read_only: z.boolean().default(true),
  })
  .default({ max_rows: 1000, timeout_ms: 30_000, read_only: true });

export const AppConfigSchema = z.object({
  default_server: z.string().optional(),
  defaults: DefaultsSchema,
  servers: z.record(z.string(), ServerSchema).refine((m) => Object.keys(m).length > 0, {
    message: 'At least one server must be configured under `servers:`',
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type ServerConfig = z.infer<typeof ServerSchema>;
export type AuthConfig = z.infer<typeof AuthSchema>;

export function loadConfig(path: string): AppConfig {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw);
  const result = AppConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config (${path}):\n${result.error.toString()}`);
  }
  return result.data;
}
