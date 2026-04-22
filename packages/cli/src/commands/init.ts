import prompts from 'prompts';
import { scaffoldConfig, readWebAdapterConfig, updateWebAdapterConfig } from './config-writer.js';
import { defaultConfigPath, defaultEnvPath } from '../paths.js';
import { detectTailscaleIPv4 } from '../tailscale.js';

export interface InitOptions {
  configPath?: string | undefined;
  envPath?: string | undefined;
  webBind: string;
  webPort: number;
}

export interface InitResult {
  configPath: string;
  envPath: string;
  created: boolean;
  updated: boolean;
  webBind: string;
  webPort: number;
}

export function runInit(opts: InitOptions): InitResult {
  const configPath = opts.configPath ?? defaultConfigPath();
  const envPath = opts.envPath ?? defaultEnvPath();
  const scaffold = scaffoldConfig({
    configPath,
    envPath,
    webBind: opts.webBind,
    webPort: opts.webPort,
  });

  let updated = false;
  if (!scaffold.created) {
    const existing = readWebAdapterConfig(configPath);
    if (!existing || existing.bind !== opts.webBind || existing.port !== opts.webPort) {
      updateWebAdapterConfig({ configPath, bind: opts.webBind, port: opts.webPort });
      updated = true;
    }
  }

  return {
    configPath,
    envPath,
    created: scaffold.created,
    updated,
    webBind: opts.webBind,
    webPort: opts.webPort,
  };
}

export interface InteractiveInitOptions {
  configPath?: string | undefined;
  envPath?: string | undefined;
  bindOverride?: string | undefined;
  portOverride?: number | undefined;
  nonInteractive?: boolean | undefined;
}

export async function interactiveInit(opts: InteractiveInitOptions): Promise<InitResult> {
  const configPath = opts.configPath ?? defaultConfigPath();
  const envPath = opts.envPath ?? defaultEnvPath();
  const existing = readWebAdapterConfig(configPath);
  const tailscaleIp = detectTailscaleIPv4();

  const bind = opts.bindOverride ?? (await promptForBind(existing?.bind, tailscaleIp, opts.nonInteractive));
  const port = opts.portOverride ?? (await promptForPort(existing?.port, opts.nonInteractive));

  return runInit({ configPath, envPath, webBind: bind, webPort: port });
}

async function promptForBind(
  existing: string | undefined,
  tailscaleIp: string | undefined,
  nonInteractive: boolean | undefined,
): Promise<string> {
  const defaultBind = existing ?? '127.0.0.1';
  if (nonInteractive || !process.stdin.isTTY) return defaultBind;

  const choices: Array<{ title: string; value: string }> = [
    { title: `127.0.0.1 (local only)`, value: '127.0.0.1' },
  ];
  if (tailscaleIp) {
    choices.push({ title: `${tailscaleIp} (Tailscale)`, value: tailscaleIp });
  }
  choices.push({ title: 'Enter a custom address', value: '__custom__' });

  const initialIdx = Math.max(
    0,
    choices.findIndex((c) => c.value === defaultBind),
  );

  const { bind } = (await prompts({
    type: 'select',
    name: 'bind',
    message: 'Bind address for the web dashboard',
    choices,
    initial: initialIdx,
  })) as { bind?: string };

  if (bind === undefined) throw new Error('cancelled');
  if (bind !== '__custom__') return bind;

  const { custom } = (await prompts({
    type: 'text',
    name: 'custom',
    message: 'Custom bind address',
    initial: defaultBind,
    validate: (v: string) => (v.trim().length > 0 ? true : 'required'),
  })) as { custom?: string };
  if (custom === undefined) throw new Error('cancelled');
  return custom.trim();
}

async function promptForPort(
  existing: number | undefined,
  nonInteractive: boolean | undefined,
): Promise<number> {
  const defaultPort = existing ?? 7781;
  if (nonInteractive || !process.stdin.isTTY) return defaultPort;
  const { port } = (await prompts({
    type: 'number',
    name: 'port',
    message: 'Port for the web dashboard',
    initial: defaultPort,
    min: 1,
    max: 65535,
  })) as { port?: number };
  if (port === undefined) throw new Error('cancelled');
  return port;
}
