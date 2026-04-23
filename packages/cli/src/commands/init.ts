import prompts from 'prompts';
import { scaffoldConfig, readWebAdapterConfig, updateWebAdapterConfig } from './config-writer.js';
import { defaultConfigPath, defaultEnvPath } from '../paths.js';
import { detectTailscaleIPv4 } from '../tailscale.js';
import {
  daemonReload,
  defaultUserUnitPath,
  enableSystemdUnit,
  hasLingerEnabled,
  installSystemdUnit,
  isSystemdUserAvailable,
  resolveNodeBinary,
  resolveRederdBinary,
} from './systemd.js';

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
  service?: ServiceInstallResult;
}

export interface ServiceInstallResult {
  skipped: boolean;
  reason?: string;
  unitPath?: string;
  unitWritten?: boolean;
  daemonReloaded?: boolean;
  enabled?: boolean;
  enableDetail?: string;
  lingerEnabled?: boolean;
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

export interface InstallServiceOptions {
  configPath: string;
  unitPath?: string | undefined;
  nodePath?: string | undefined;
  binaryPath?: string | undefined;
  enable?: boolean | undefined;
}

/**
 * Install the systemd user unit for reder. Caller is responsible for deciding
 * whether to call this at all (host support + user consent). Returns a result
 * describing what happened so callers can surface it to the user.
 */
export function installRederService(opts: InstallServiceOptions): ServiceInstallResult {
  if (!isSystemdUserAvailable()) {
    return { skipped: true, reason: 'systemd user services not available on this host' };
  }
  const binaryPath = opts.binaryPath ?? resolveRederdBinary();
  if (!binaryPath) {
    return {
      skipped: true,
      reason: "could not resolve 'rederd' on PATH (is the package installed globally?)",
    };
  }
  const nodePath = opts.nodePath ?? resolveNodeBinary();
  if (!nodePath) {
    return {
      skipped: true,
      reason: "could not resolve 'node' on PATH (required for the systemd ExecStart)",
    };
  }
  const unitPath = opts.unitPath ?? defaultUserUnitPath();
  const install = installSystemdUnit({
    unitPath,
    nodePath,
    binaryPath,
    configPath: opts.configPath,
  });
  const reload = daemonReload();

  const result: ServiceInstallResult = {
    skipped: false,
    unitPath: install.unitPath,
    unitWritten: install.installed,
    daemonReloaded: reload.ok,
  };

  if (opts.enable !== false) {
    const en = enableSystemdUnit();
    result.enabled = en.ok;
    result.enableDetail = en.detail;
    result.lingerEnabled = hasLingerEnabled();
  }

  return result;
}

export interface InteractiveInitOptions {
  configPath?: string | undefined;
  envPath?: string | undefined;
  bindOverride?: string | undefined;
  portOverride?: number | undefined;
  nonInteractive?: boolean | undefined;
  /** Force install/skip decision instead of prompting. */
  installService?: boolean | undefined;
}

export async function interactiveInit(opts: InteractiveInitOptions): Promise<InitResult> {
  const configPath = opts.configPath ?? defaultConfigPath();
  const envPath = opts.envPath ?? defaultEnvPath();
  const existing = readWebAdapterConfig(configPath);
  const tailscaleIp = detectTailscaleIPv4();

  const bind =
    opts.bindOverride ?? (await promptForBind(existing?.bind, tailscaleIp, opts.nonInteractive));
  const port = opts.portOverride ?? (await promptForPort(existing?.port, opts.nonInteractive));

  const result = runInit({ configPath, envPath, webBind: bind, webPort: port });

  const install = await decideServiceInstall(configPath, opts);
  if (install !== undefined) result.service = install;

  return result;
}

async function decideServiceInstall(
  configPath: string,
  opts: InteractiveInitOptions,
): Promise<ServiceInstallResult | undefined> {
  if (opts.installService === false) return undefined;
  if (!isSystemdUserAvailable()) {
    // Silently skip on non-systemd hosts — nothing to ask, nothing to do.
    return undefined;
  }

  if (opts.installService !== true) {
    if (opts.nonInteractive || !process.stdin.isTTY) {
      // Don't touch user infrastructure without explicit consent in scripted flows.
      return undefined;
    }
    const { install } = (await prompts({
      type: 'confirm',
      name: 'install',
      message: 'Install reder as a systemd user service so it auto-starts at login?',
      initial: true,
    })) as { install?: boolean };
    if (install === undefined) throw new Error('cancelled');
    if (!install) return undefined;
  }

  return installRederService({ configPath, enable: true });
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
