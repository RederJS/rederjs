import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderServiceUnit, installSystemdUnit } from '../src/commands/systemd.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-cli-systemd-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('renderServiceUnit', () => {
  it('execs node directly with the rederd script as its argument so shebangs are bypassed', () => {
    const unit = renderServiceUnit({
      nodePath: '/home/alice/.nvm/versions/node/v20.11.0/bin/node',
      binaryPath: '/home/alice/.nvm/versions/node/v20.11.0/bin/rederd',
      configPath: '/home/alice/.config/reder/reder.config.yaml',
    });
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('Type=exec');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain(
      'ExecStart="/home/alice/.nvm/versions/node/v20.11.0/bin/node" ' +
        '"/home/alice/.nvm/versions/node/v20.11.0/bin/rederd" ' +
        '--config "/home/alice/.config/reder/reder.config.yaml"',
    );
    expect(unit).toContain('Restart=');
  });

  it('puts the node install dir onto PATH so subprocesses (tmux etc.) resolve', () => {
    const unit = renderServiceUnit({
      nodePath: '/home/linuxbrew/.linuxbrew/bin/node',
      binaryPath: '/home/linuxbrew/.linuxbrew/bin/rederd',
      configPath: '/home/alice/.config/reder/reder.config.yaml',
    });
    const pathLine = unit.split('\n').find((l) => l.startsWith('Environment=PATH='));
    expect(pathLine).toBeDefined();
    expect(pathLine).toContain('/home/linuxbrew/.linuxbrew/bin');
    expect(pathLine).toContain('/usr/local/bin');
    expect(pathLine).toContain('/usr/bin');
  });

  it('double-quotes paths with spaces so systemd parses them as single tokens', () => {
    const unit = renderServiceUnit({
      nodePath: '/opt/my tools/node',
      binaryPath: '/opt/my tools/rederd',
      configPath: '/home/al ice/reder.yaml',
    });
    expect(unit).toContain(
      'ExecStart="/opt/my tools/node" "/opt/my tools/rederd" --config "/home/al ice/reder.yaml"',
    );
  });
});

describe('installSystemdUnit', () => {
  it('writes the rendered unit to the given path and reports installed=true', () => {
    const unitPath = join(dir, 'reder.service');
    const result = installSystemdUnit({
      unitPath,
      nodePath: '/usr/bin/node',
      binaryPath: '/usr/bin/rederd',
      configPath: '/home/alice/.config/reder/reder.config.yaml',
    });
    expect(result.installed).toBe(true);
    expect(result.unitPath).toBe(unitPath);
    expect(existsSync(unitPath)).toBe(true);
    const text = readFileSync(unitPath, 'utf8');
    expect(text).toContain('ExecStart="/usr/bin/node" "/usr/bin/rederd"');
  });

  it('is idempotent: re-running with the same inputs reports installed=false', () => {
    const unitPath = join(dir, 'reder.service');
    const inputs = {
      unitPath,
      nodePath: '/usr/bin/node',
      binaryPath: '/usr/bin/rederd',
      configPath: '/home/alice/.config/reder/reder.config.yaml',
    };
    installSystemdUnit(inputs);
    const result = installSystemdUnit(inputs);
    expect(result.installed).toBe(false);
  });

  it('overwrites the file when the desired contents change', () => {
    const unitPath = join(dir, 'reder.service');
    installSystemdUnit({
      unitPath,
      nodePath: '/usr/bin/node',
      binaryPath: '/usr/bin/rederd',
      configPath: '/old/path.yaml',
    });
    const result = installSystemdUnit({
      unitPath,
      nodePath: '/usr/bin/node',
      binaryPath: '/usr/bin/rederd',
      configPath: '/new/path.yaml',
    });
    expect(result.installed).toBe(true);
    const text = readFileSync(unitPath, 'utf8');
    expect(text).toContain('/new/path.yaml');
    expect(text).not.toContain('/old/path.yaml');
  });

  it('creates the parent directory if it does not exist', () => {
    const unitPath = join(dir, 'nested', 'systemd', 'user', 'reder.service');
    installSystemdUnit({
      unitPath,
      nodePath: '/usr/bin/node',
      binaryPath: '/usr/bin/rederd',
      configPath: '/cfg.yaml',
    });
    expect(existsSync(unitPath)).toBe(true);
  });
});
