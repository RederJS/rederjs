import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z, ZodError } from 'zod';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const sessionIdRe = /^[a-z0-9][a-z0-9_-]{1,62}$/;

export const ConfigSchemaV1 = z
  .object({
    version: z.literal(1),
    runtime: z
      .object({
        runtime_dir: z.string().default('~/.local/share/reder'),
        data_dir: z.string().default('~/.local/share/reder/data'),
      })
      .default({}),
    logging: z
      .object({
        level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
        pretty: z.enum(['auto', 'yes', 'no']).default('auto'),
      })
      .default({}),
    health: z
      .object({
        enabled: z.boolean().default(true),
        bind: z.string().default('127.0.0.1'),
        port: z.number().int().min(1).max(65535).default(7781),
      })
      .default({}),
    storage: z
      .object({
        retention: z
          .object({
            inbound_acknowledged_days: z.number().int().positive().default(7),
            outbound_sent_days: z.number().int().positive().default(7),
            permissions_days: z.number().int().positive().default(30),
            terminal_errors_days: z.number().int().positive().default(30),
          })
          .default({}),
      })
      .default({}),
    security: z
      .object({
        rate_limit: z
          .object({
            per_sender_per_minute: z.number().int().positive().default(60),
          })
          .default({}),
        permission_default_on_timeout: z.enum(['deny', 'allow']).default('deny'),
        permission_timeout_seconds: z.number().int().positive().default(600),
      })
      .default({}),
    sessions: z
      .array(
        z.object({
          session_id: z.string().regex(sessionIdRe),
          display_name: z.string().min(1),
          workspace_dir: z.string().min(1).optional(),
          auto_start: z.boolean().default(false),
          permission_mode: z
            .enum(['default', 'plan', 'acceptEdits', 'bypassPermissions'])
            .default('default'),
        }),
      )
      .default([]),
    adapters: z
      .record(
        z.string(),
        z.object({
          module: z.string(),
          enabled: z.boolean().default(true),
          config: z.unknown().optional(),
        }),
      )
      .default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchemaV1>;

const INDIRECTION_RE = /\$\{(env|file):([^}]+)\}/g;

/**
 * Walk a parsed YAML tree and substitute ${env:VAR} / ${file:/path} references in
 * any string leaf. Applied before zod parse so substituted values still validate.
 */
function substituteIndirections(node: unknown, context: SubstContext): unknown {
  if (typeof node === 'string') {
    return node.replace(INDIRECTION_RE, (_match, kind: string, ref: string) => {
      if (kind === 'env') {
        const val = process.env[ref];
        if (val === undefined) {
          throw new ConfigError(
            `Config references environment variable '${ref}' which is not set at path ${context.path}`,
          );
        }
        return val;
      }
      if (kind === 'file') {
        try {
          return readFileSync(ref, 'utf8').trimEnd();
        } catch (err) {
          throw new ConfigError(
            `Config references file '${ref}' which could not be read at path ${context.path}: ${(err as Error).message}`,
          );
        }
      }
      return _match;
    });
  }
  if (Array.isArray(node)) {
    return node.map((v, i) => substituteIndirections(v, { path: `${context.path}[${i}]` }));
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = substituteIndirections(v, { path: `${context.path}.${k}` });
    }
    return out;
  }
  return node;
}

interface SubstContext {
  path: string;
}

/**
 * Load reder.env (KEY=VALUE lines, `#` comments) into process.env without overwriting
 * already-set variables.
 */
function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export interface LoadConfigOptions {
  envFilePath?: string;
}

export function loadConfig(configPath: string, opts: LoadConfigOptions = {}): Config {
  const envPath = opts.envFilePath ?? join(dirname(configPath), 'reder.env');
  loadEnvFile(envPath);

  let rawYaml: string;
  try {
    rawYaml = readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read config at ${configPath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    throw new ConfigError(`Invalid YAML in ${configPath}: ${(err as Error).message}`);
  }

  const substituted = substituteIndirections(parsed ?? {}, { path: '$' });

  try {
    return ConfigSchemaV1.parse(substituted);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      throw new ConfigError(`Invalid config ${configPath}:\n${issues}`);
    }
    throw err;
  }
}
