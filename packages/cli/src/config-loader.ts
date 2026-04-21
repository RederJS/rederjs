import { existsSync } from 'node:fs';
import { loadConfig, type Config, ConfigError } from '@rederjs/core/config';
import { defaultConfigPath, expandHome } from './paths.js';

export interface LoadedConfigContext {
  config: Config;
  configPath: string;
  runtimeDir: string;
  dataDir: string;
}

export function loadConfigContext(configPathInput?: string): LoadedConfigContext {
  const configPath =
    configPathInput ?? process.env['REDER_CONFIG'] ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new ConfigError(`Config not found at ${configPath}. Run 'reder init' to create one.`);
  }
  const config = loadConfig(configPath);
  return {
    config,
    configPath,
    runtimeDir: expandHome(config.runtime.runtime_dir),
    dataDir: expandHome(config.runtime.data_dir),
  };
}
