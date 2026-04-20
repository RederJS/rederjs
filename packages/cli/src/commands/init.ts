import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultConfigPath, defaultEnvPath, defaultRuntimeDir, defaultDataDir } from '../paths.js';

export interface InitOptions {
  force?: boolean | undefined;
  botToken?: string | undefined;
  sessionId?: string | undefined;
  displayName?: string | undefined;
  configPath?: string | undefined;
  envPath?: string | undefined;
  telegramTokenEnv?: string | undefined;
}

export interface InitResult {
  configPath: string;
  envPath: string;
  sessionId: string;
  tokenEnvVar: string;
}

/**
 * Non-interactive init. Interactive prompting is delegated to callers that
 * provide inputs; we keep init logic pure for testing.
 */
export function runInit(opts: InitOptions): InitResult {
  const configPath = opts.configPath ?? defaultConfigPath();
  const envPath = opts.envPath ?? defaultEnvPath();
  const sessionId = opts.sessionId ?? 'default';
  const displayName = opts.displayName ?? 'Default';
  const tokenEnvVar = opts.telegramTokenEnv ?? `TELEGRAM_BOT_${sessionId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

  if (!opts.force) {
    if (existsSync(configPath)) {
      throw new Error(
        `Config already exists at ${configPath}. Use --force to overwrite.`,
      );
    }
  }

  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(dirname(envPath), { recursive: true });
  mkdirSync(defaultRuntimeDir(), { recursive: true, mode: 0o700 });
  mkdirSync(defaultDataDir(), { recursive: true, mode: 0o700 });

  const yaml = `version: 1

runtime:
  runtime_dir: ${defaultRuntimeDir()}
  data_dir: ${defaultDataDir()}

logging:
  level: info

health:
  enabled: true
  bind: 127.0.0.1
  port: 7781

sessions:
  - session_id: ${sessionId}
    display_name: ${displayName}

adapters:
  telegram:
    module: '@reder/adapter-telegram'
    enabled: true
    config:
      bots:
        - token_env: ${tokenEnvVar}
          session_id: ${sessionId}
`;

  writeFileSync(configPath, yaml, { mode: 0o600 });
  chmodSync(configPath, 0o600);

  const envLine = opts.botToken ? `${tokenEnvVar}=${opts.botToken}\n` : `# ${tokenEnvVar}=<paste your Telegram bot token here>\n`;
  const envExisting = existsSync(envPath) ? `\n${envLine}` : envLine;
  writeFileSync(envPath, envExisting, { mode: 0o600, flag: existsSync(envPath) ? 'a' : 'w' });
  chmodSync(envPath, 0o600);

  return { configPath, envPath, sessionId, tokenEnvVar };
}
