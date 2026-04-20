import { loadConfig, ConfigError } from '@reder/core/config';
import { defaultConfigPath } from '../paths.js';

export interface ConfigValidateResult {
  valid: boolean;
  path: string;
  error?: string;
}

export function runConfigValidate(opts: { configPath?: string } = {}): ConfigValidateResult {
  const path = opts.configPath ?? process.env['REDER_CONFIG'] ?? defaultConfigPath();
  try {
    loadConfig(path);
    return { valid: true, path };
  } catch (err) {
    if (err instanceof ConfigError) {
      return { valid: false, path, error: err.message };
    }
    return { valid: false, path, error: (err as Error).message };
  }
}
