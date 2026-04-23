import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export interface RenderServiceUnitOptions {
  nodePath: string;
  binaryPath: string;
  configPath: string;
}

const DEFAULT_SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function renderServiceUnit(opts: RenderServiceUnitOptions): string {
  const { nodePath, binaryPath, configPath } = opts;
  // systemd user's PATH is minimal; prepend the node install dir AND the
  // user-local bin dirs (~/.local/bin, ~/bin) so the daemon's subprocesses
  // (tmux → claude, etc.) can find tools installed by npm i -g, pipx, curl
  // installers, and similar. Without these, the daemon can spawn tmux but
  // tmux fails to find `claude` and the sessions die immediately.
  const home = homedir();
  const servicePath = [
    dirname(nodePath),
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    DEFAULT_SYSTEM_PATH,
  ].join(':');
  // Invoke node directly on the script to bypass `#!/usr/bin/env node`, which
  // relies on PATH resolution that can differ under systemd.
  return (
    `[Unit]\n` +
    `Description=reder daemon\n` +
    `After=network.target\n` +
    `\n` +
    `[Service]\n` +
    `Type=exec\n` +
    `Environment=PATH=${servicePath}\n` +
    `ExecStart="${nodePath}" "${binaryPath}" --config "${configPath}"\n` +
    `Restart=on-failure\n` +
    `RestartSec=3\n` +
    `\n` +
    `[Install]\n` +
    `WantedBy=default.target\n`
  );
}

export function defaultUserUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', 'reder.service');
}

export interface InstallSystemdUnitOptions {
  unitPath: string;
  nodePath: string;
  binaryPath: string;
  configPath: string;
}

export interface InstallSystemdUnitResult {
  installed: boolean;
  unitPath: string;
}

/**
 * Writes (or updates) the systemd user unit for reder at `unitPath`.
 * Does not run `daemon-reload` or enable/restart; the caller drives that.
 */
export function installSystemdUnit(opts: InstallSystemdUnitOptions): InstallSystemdUnitResult {
  const { unitPath, nodePath, binaryPath, configPath } = opts;
  const desired = renderServiceUnit({ nodePath, binaryPath, configPath });

  if (existsSync(unitPath)) {
    const current = readFileSync(unitPath, 'utf8');
    if (current === desired) {
      return { installed: false, unitPath };
    }
  }

  mkdirSync(dirname(unitPath), { recursive: true });
  const tmp = `${unitPath}.tmp`;
  writeFileSync(tmp, desired, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, unitPath);
  return { installed: true, unitPath };
}

/** Is `systemctl --user` usable on this host? (Linux + running user systemd.) */
export function isSystemdUserAvailable(): boolean {
  if (platform() !== 'linux') return false;
  const res = spawnSync('systemctl', ['--user', 'status'], { stdio: 'ignore' });
  // 0 = running, 3 = inactive but present
  return res.status === 0 || res.status === 3;
}

/** Is the reder.service unit actually known to user systemd? */
export function hasRederUserUnit(): boolean {
  if (!isSystemdUserAvailable()) return false;
  const res = spawnSync('systemctl', ['--user', 'cat', 'reder.service'], { stdio: 'ignore' });
  return res.status === 0;
}

/** Reload user systemd so it picks up a freshly-written unit. */
export function daemonReload(): { ok: boolean; detail: string } {
  const res = spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  return res.status === 0
    ? { ok: true, detail: 'systemctl --user daemon-reload ok' }
    : { ok: false, detail: `systemctl --user daemon-reload failed: ${res.status}` };
}

/**
 * Enable the unit, clear any prior failed state, and (re)start it.
 * Safer than `enable --now` when a crash-looping unit may already be in
 * `activating (auto-restart)` — that state can swallow `--now` starts.
 */
export function enableSystemdUnit(): { ok: boolean; detail: string } {
  const enable = spawnSync('systemctl', ['--user', 'enable', 'reder'], { stdio: 'inherit' });
  if (enable.status !== 0) {
    return { ok: false, detail: `systemctl --user enable reder failed: ${enable.status}` };
  }
  // Best-effort: ignore if the unit has never failed.
  spawnSync('systemctl', ['--user', 'reset-failed', 'reder'], { stdio: 'ignore' });
  const restart = spawnSync('systemctl', ['--user', 'restart', 'reder'], { stdio: 'inherit' });
  return restart.status === 0
    ? { ok: true, detail: 'systemctl --user enable + restart reder ok' }
    : { ok: false, detail: `systemctl --user restart reder failed: ${restart.status}` };
}

/** Resolve the absolute path to a binary on this host via `which`. Returns undefined if not found. */
function resolveOnPath(binary: string): string | undefined {
  const res = spawnSync('which', [binary], { encoding: 'utf8' });
  if (res.status !== 0) return undefined;
  const path = res.stdout.trim();
  return path.length > 0 ? path : undefined;
}

export function resolveRederdBinary(): string | undefined {
  return resolveOnPath('rederd');
}

export function resolveNodeBinary(): string | undefined {
  return resolveOnPath('node');
}

/** Check whether `loginctl show-user $USER` reports Linger=yes. */
export function hasLingerEnabled(): boolean {
  const user = process.env['USER'];
  if (!user) return false;
  const res = spawnSync('loginctl', ['show-user', user, '--property=Linger', '--value'], {
    encoding: 'utf8',
  });
  if (res.status !== 0) return false;
  return res.stdout.trim() === 'yes';
}
