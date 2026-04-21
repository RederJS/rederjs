#!/usr/bin/env node
import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runInstall } from './commands/install.js';
import { runStatus, formatStatus } from './commands/status.js';
import { runDoctor, formatDoctor } from './commands/doctor.js';
import { runPair, formatPairResult } from './commands/pair.js';
import { runStart, runStop, runRestart } from './commands/service.js';
import { runConfigValidate } from './commands/config.js';
import {
  runSessionsList,
  formatSessionsList,
  runSessionStart,
  formatSessionStart,
  runSessionsUp,
  formatSessionsUp,
} from './commands/sessions.js';
import { runDashboardUrl, formatDashboardUrl } from './commands/dashboard.js';

const VERSION = '0.1.0';

const program = new Command();
program
  .name('reder')
  .description('Reder CLI — manage the reder daemon and paired Telegram sessions')
  .version(VERSION);

program.option('--json', 'output machine-readable JSON where supported');
program.option('--config <path>', 'path to reder.config.yaml');

function jsonMode(): boolean {
  return Boolean(program.opts().json);
}

function configArg(): string | undefined {
  return (program.opts().config as string | undefined) ?? undefined;
}

function buildCfgOpts(): { configPath?: string } {
  const c = configArg();
  return c !== undefined ? { configPath: c } : {};
}

program
  .command('init')
  .description('generate a minimal reder.config.yaml + reder.env')
  .option('--force', 'overwrite existing config')
  .option('--session-id <id>', 'primary session id', 'default')
  .option('--display-name <name>', 'display name for the session')
  .option('--bot-token <token>', 'Telegram bot token (stored in reder.env)')
  .option('--token-env <VAR>', 'env variable name for the token')
  .action(async (opts: Record<string, unknown>) => {
    try {
      const result = runInit({
        force: opts['force'] as boolean,
        sessionId: opts['sessionId'] as string,
        displayName: opts['displayName'] as string | undefined,
        botToken: opts['botToken'] as string | undefined,
        telegramTokenEnv: opts['tokenEnv'] as string | undefined,
      });
      if (jsonMode()) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        process.stdout.write(
          `Wrote ${result.configPath}\nWrote ${result.envPath}\nNext: set ${result.tokenEnvVar} in reder.env and run 'reder install ${result.sessionId}' in your project.\n`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('install <session-id>')
  .description('register a session with rederd and write a .mcp.json shim entry in the current project')
  .option('--display-name <name>', 'display name for this session')
  .option('--project-dir <path>', 'project directory to write .mcp.json into', process.cwd())
  .option(
    '--shim-command <cmd>',
    'command to invoke reder-shim (default: "reder-shim")',
    'reder-shim',
  )
  .action(async (sessionId: string, opts: Record<string, unknown>) => {
    try {
      const result = await runInstall({
        sessionId,
        displayName: opts['displayName'] as string | undefined,
        projectDir: opts['projectDir'] as string | undefined,
        configPath: configArg(),
        shimCommand: [opts['shimCommand'] as string],
      });
      if (jsonMode()) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        process.stdout.write(
          `Installed session '${result.sessionId}'${result.tokenRotated ? ' (token rotated)' : ''}\n` +
            `.mcp.json: ${result.mcpJsonPath}\n` +
            `Socket: ${result.socketPath}\n` +
            `Start Claude Code with:\n  claude --dangerously-load-development-channels server:reder\n`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('start')
  .description('start the rederd daemon')
  .action(() => {
    const r = runStart(buildCfgOpts());
    if (jsonMode()) process.stdout.write(JSON.stringify(r) + '\n');
    else process.stdout.write(`${r.ok ? '✓' : '✗'} ${r.detail}\n`);
    process.exit(r.ok ? 0 : 1);
  });

program
  .command('stop')
  .description('stop the rederd daemon')
  .action(() => {
    const r = runStop(buildCfgOpts());
    if (jsonMode()) process.stdout.write(JSON.stringify(r) + '\n');
    else process.stdout.write(`${r.ok ? '✓' : '✗'} ${r.detail}\n`);
    process.exit(r.ok ? 0 : 1);
  });

program
  .command('restart')
  .description('restart the rederd daemon')
  .action(() => {
    const r = runRestart(buildCfgOpts());
    if (jsonMode()) process.stdout.write(JSON.stringify(r) + '\n');
    else process.stdout.write(`${r.ok ? '✓' : '✗'} ${r.detail}\n`);
    process.exit(r.ok ? 0 : 1);
  });

program
  .command('status')
  .description('show daemon status')
  .action(async () => {
    const r = await runStatus(buildCfgOpts());
    if (jsonMode()) process.stdout.write(JSON.stringify(r) + '\n');
    else process.stdout.write(formatStatus(r) + '\n');
    process.exit(r.reachable ? 0 : 1);
  });

program
  .command('doctor')
  .description('run diagnostic checks and print pass/fail')
  .action(async () => {
    const checks = await runDoctor(buildCfgOpts());
    if (jsonMode()) process.stdout.write(JSON.stringify(checks) + '\n');
    else process.stdout.write(formatDoctor(checks) + '\n');
    process.exit(checks.every((c) => c.pass) ? 0 : 1);
  });

program
  .command('pair <code>')
  .description('redeem a 6-char pair code sent by the Telegram bot')
  .action(async (code: string) => {
    try {
      const result = await runPair({ code });
      if (jsonMode()) process.stdout.write(JSON.stringify(result) + '\n');
      else process.stdout.write(formatPairResult(result) + '\n');
      process.exit(result.success ? 0 : 1);
    } catch (err) {
      fail(err);
    }
  });

const config = program.command('config').description('config management');
config
  .command('validate [path]')
  .description('validate a reder.config.yaml file')
  .action((path?: string) => {
    const r = runConfigValidate(path !== undefined ? { configPath: path } : {});
    if (jsonMode()) process.stdout.write(JSON.stringify(r) + '\n');
    else if (r.valid) process.stdout.write(`✓ ${r.path} is valid\n`);
    else process.stdout.write(`✗ ${r.path}:\n${r.error}\n`);
    process.exit(r.valid ? 0 : 1);
  });

const sessions = program.command('sessions').description('manage tmux-hosted Claude Code sessions');
sessions
  .command('list')
  .description('list configured sessions and their tmux status')
  .action(() => {
    try {
      const r = runSessionsList(buildCfgOpts());
      if (jsonMode()) process.stdout.write(JSON.stringify(r) + '\n');
      else process.stdout.write(formatSessionsList(r) + '\n');
    } catch (err) {
      fail(err);
    }
  });

sessions
  .command('start <session-id>')
  .description('start a tmux session (running `claude`) in the configured workspace_dir')
  .action((sessionId: string) => {
    try {
      const r = runSessionStart({ sessionId, ...buildCfgOpts() });
      if (jsonMode()) process.stdout.write(JSON.stringify(r) + '\n');
      else process.stdout.write(formatSessionStart(r) + '\n');
      process.exit(r.started || r.reason === 'already_running' ? 0 : 1);
    } catch (err) {
      fail(err);
    }
  });

sessions
  .command('up')
  .description('start every configured session with a workspace_dir (idempotent)')
  .action(() => {
    try {
      const r = runSessionsUp(buildCfgOpts());
      if (jsonMode()) process.stdout.write(JSON.stringify(r) + '\n');
      else process.stdout.write(formatSessionsUp(r) + '\n');
    } catch (err) {
      fail(err);
    }
  });

const dashboard = program.command('dashboard').description('web dashboard helpers');
dashboard
  .command('url')
  .description('print a one-time authenticated URL for the web dashboard')
  .action(() => {
    try {
      const r = runDashboardUrl(buildCfgOpts());
      if (jsonMode()) process.stdout.write(JSON.stringify(r) + '\n');
      else process.stdout.write(formatDashboardUrl(r) + '\n');
    } catch (err) {
      fail(err);
    }
  });

program
  .command('logs')
  .description('tail logs (placeholder — delegates to journalctl on systemd hosts)')
  .action(() => {
    process.stdout.write(
      'Use `journalctl --user -fu reder` on systemd hosts, or tail the daemon output directly.\n',
    );
    process.exit(0);
  });

function fail(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (jsonMode()) {
    process.stdout.write(JSON.stringify({ error: msg }) + '\n');
  } else {
    process.stderr.write(`reder: ${msg}\n`);
  }
  process.exit(1);
}

program.parseAsync(process.argv).catch(fail);
