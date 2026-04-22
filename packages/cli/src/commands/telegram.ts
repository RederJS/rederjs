import { existsSync } from 'node:fs';
import prompts from 'prompts';
import { defaultConfigPath } from '../paths.js';
import {
  addTelegramAllowlistUser,
  getTelegramMode,
  listTelegramAllowlistUsers,
  listTelegramBots,
  removeTelegramAllowlistUser,
  removeTelegramBot,
  setTelegramMode,
  upsertTelegramBot,
  type TelegramBotEntry,
  type TelegramMode,
} from './config-writer.js';
import { validateSessionId } from '../session-id.js';

export class ConfigNotFoundError extends Error {
  override readonly name = 'ConfigNotFoundError';
  constructor(public readonly configPath: string) {
    super(`No config found at ${configPath}. Run 'reder init' first.`);
  }
}

function resolveConfigPath(p?: string): string {
  const cp = p ?? defaultConfigPath();
  if (!existsSync(cp)) throw new ConfigNotFoundError(cp);
  return cp;
}

// -----------------------------------------------------------------------------
// Bot
// -----------------------------------------------------------------------------

export interface TelegramBotAddOptions {
  sessionId: string;
  configPath?: string | undefined;
  token?: string | undefined;
  tokenEnv?: string | undefined;
  nonInteractive?: boolean | undefined;
}

export type TelegramBotAddTokenSource = 'inline' | 'env';

export interface TelegramBotAddResult {
  sessionId: string;
  configPath: string;
  tokenSource: TelegramBotAddTokenSource;
  tokenEnv?: string;
  yamlCreated: boolean;
}

export async function runTelegramBotAdd(
  opts: TelegramBotAddOptions,
): Promise<TelegramBotAddResult> {
  const configPath = resolveConfigPath(opts.configPath);

  const validated = validateSessionId(opts.sessionId);
  if (validated !== true) {
    throw new Error(`invalid session id: ${validated}`);
  }

  // Resolve token source. Precedence: explicit --token-env > --token > prompt.
  // Inline-in-YAML is the default; --token-env is the escape hatch for users
  // who want tokens to come from an external env source (systemd drop-in,
  // secret manager, etc.).
  if (opts.tokenEnv) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(opts.tokenEnv)) {
      throw new Error(`--token-env must match /^[A-Z][A-Z0-9_]*$/ (got '${opts.tokenEnv}')`);
    }
    const upsert = upsertTelegramBot({
      configPath,
      sessionId: opts.sessionId,
      tokenEnv: opts.tokenEnv,
    });
    return {
      sessionId: opts.sessionId,
      configPath,
      tokenSource: 'env',
      tokenEnv: opts.tokenEnv,
      yamlCreated: upsert.created,
    };
  }

  let token: string;
  if (opts.token) {
    token = opts.token;
  } else {
    if (opts.nonInteractive || !process.stdin.isTTY) {
      throw new Error(
        'Telegram bot token required. Pass --token <value>, or --token-env <VAR> to reference an existing env var, or run interactively.',
      );
    }
    const { t } = (await prompts({
      type: 'password',
      name: 't',
      message: `Bot token for session '${opts.sessionId}' (from @BotFather)`,
      validate: (v: string) => (v.trim().length > 0 ? true : 'required'),
    })) as { t?: string };
    if (t === undefined) throw new Error('cancelled');
    token = t.trim();
  }

  const upsert = upsertTelegramBot({ configPath, sessionId: opts.sessionId, token });
  return {
    sessionId: opts.sessionId,
    configPath,
    tokenSource: 'inline',
    yamlCreated: upsert.created,
  };
}

export function formatTelegramBotAdd(r: TelegramBotAddResult): string {
  const verb = r.yamlCreated ? 'Added' : 'Updated';
  const src =
    r.tokenSource === 'env' ? ` (token from env:${r.tokenEnv})` : ' (token inline)';
  return (
    `${verb} telegram bot for session '${r.sessionId}'${src} → ${r.configPath}\n` +
    `Restart the daemon: reder restart`
  );
}

export interface TelegramBotRemoveOptions {
  sessionId: string;
  configPath?: string | undefined;
}

export interface TelegramBotRemoveResult {
  sessionId: string;
  configPath: string;
  removed: boolean;
}

export function runTelegramBotRemove(
  opts: TelegramBotRemoveOptions,
): TelegramBotRemoveResult {
  const configPath = resolveConfigPath(opts.configPath);
  const { removed } = removeTelegramBot({ configPath, sessionId: opts.sessionId });
  return { sessionId: opts.sessionId, configPath, removed };
}

export function formatTelegramBotRemove(r: TelegramBotRemoveResult): string {
  if (!r.removed) return `No telegram bot found for session '${r.sessionId}'`;
  return `Removed telegram bot for session '${r.sessionId}' from ${r.configPath}`;
}

export interface TelegramBotListResult {
  configPath: string;
  bots: TelegramBotEntry[];
}

export function runTelegramBotList(opts: {
  configPath?: string | undefined;
}): TelegramBotListResult {
  const configPath = resolveConfigPath(opts.configPath);
  return { configPath, bots: listTelegramBots({ configPath }) };
}

export function formatTelegramBotList(r: TelegramBotListResult): string {
  if (r.bots.length === 0) return 'No telegram bots configured.';
  const rows = r.bots.map((b) => {
    const src = b.token_env
      ? `env:${b.token_env}`
      : b.token
        ? 'token:***inline***'
        : '(no token)';
    return `  ${b.session_id.padEnd(24)} ${src}`;
  });
  return [`${r.bots.length} telegram bot(s):`, ...rows].join('\n');
}

// -----------------------------------------------------------------------------
// Allow-list
// -----------------------------------------------------------------------------

export interface TelegramAllowAddResult {
  configPath: string;
  userId: string;
  added: boolean;
}

export function runTelegramAllowAdd(opts: {
  userId: string;
  configPath?: string | undefined;
}): TelegramAllowAddResult {
  const configPath = resolveConfigPath(opts.configPath);
  const { added } = addTelegramAllowlistUser({ configPath, userId: opts.userId });
  return { configPath, userId: opts.userId, added };
}

export function formatTelegramAllowAdd(r: TelegramAllowAddResult): string {
  if (!r.added) return `User ${r.userId} already on allowlist`;
  return `Added ${r.userId} to telegram allowlist → ${r.configPath}`;
}

export interface TelegramAllowRemoveResult {
  configPath: string;
  userId: string;
  removed: boolean;
}

export function runTelegramAllowRemove(opts: {
  userId: string;
  configPath?: string | undefined;
}): TelegramAllowRemoveResult {
  const configPath = resolveConfigPath(opts.configPath);
  const { removed } = removeTelegramAllowlistUser({ configPath, userId: opts.userId });
  return { configPath, userId: opts.userId, removed };
}

export function formatTelegramAllowRemove(r: TelegramAllowRemoveResult): string {
  if (!r.removed) return `User ${r.userId} was not on allowlist`;
  return `Removed ${r.userId} from telegram allowlist → ${r.configPath}`;
}

export interface TelegramAllowListResult {
  configPath: string;
  users: string[];
}

export function runTelegramAllowList(opts: {
  configPath?: string | undefined;
}): TelegramAllowListResult {
  const configPath = resolveConfigPath(opts.configPath);
  return { configPath, users: listTelegramAllowlistUsers({ configPath }) };
}

export function formatTelegramAllowList(r: TelegramAllowListResult): string {
  if (r.users.length === 0) return 'Telegram allowlist is empty.';
  return [`${r.users.length} allowlisted user(s):`, ...r.users.map((u) => `  ${u}`)].join('\n');
}

// -----------------------------------------------------------------------------
// Mode
// -----------------------------------------------------------------------------

export interface TelegramModeResult {
  configPath: string;
  mode: TelegramMode;
  changed: boolean;
}

export function runTelegramMode(opts: {
  configPath?: string | undefined;
  set?: TelegramMode | undefined;
}): TelegramModeResult {
  const configPath = resolveConfigPath(opts.configPath);
  const current = getTelegramMode({ configPath });
  if (!opts.set || opts.set === current) {
    return { configPath, mode: current, changed: false };
  }
  setTelegramMode({ configPath, mode: opts.set });
  return { configPath, mode: opts.set, changed: true };
}

export function formatTelegramMode(r: TelegramModeResult): string {
  if (!r.changed) return `Telegram mode: ${r.mode}`;
  return `Telegram mode: ${r.mode} (updated ${r.configPath}; restart daemon to apply)`;
}
