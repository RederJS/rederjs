#!/usr/bin/env node
import { Command } from 'commander';
import { interactiveInit } from './commands/init.js';
import { interactiveSessionAdd } from './commands/sessions-add.js';
import { interactiveSessionRemove } from './commands/sessions-remove.js';
import { runSessionRepair } from './commands/sessions-repair.js';
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
import { PERMISSION_MODES, type PermissionMode } from '@rederjs/core/tmux';
import {
  runTelegramBotAdd,
  formatTelegramBotAdd,
  runTelegramBotRemove,
  formatTelegramBotRemove,
  runTelegramBotList,
  formatTelegramBotList,
  runTelegramAllowAdd,
  formatTelegramAllowAdd,
  runTelegramAllowRemove,
  formatTelegramAllowRemove,
  runTelegramAllowList,
  formatTelegramAllowList,
  runTelegramMode,
  formatTelegramMode,
} from './commands/telegram.js';

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
  .description('configure rederd for this machine (web bind, port); re-runnable')
  .option('--bind <addr>', 'web dashboard bind address (skip prompt)')
  .option('--port <number>', 'web dashboard port (skip prompt)', (v) => parseInt(v, 10))
  .option('--install-service', 'install and enable the systemd user service without prompting')
  .action(async (opts: Record<string, unknown>) => {
    try {
      const installService = opts['installService'] === true ? true : undefined;
      const result = await interactiveInit({
        configPath: configArg(),
        ...(opts['bind'] !== undefined ? { bindOverride: opts['bind'] as string } : {}),
        ...(opts['port'] !== undefined ? { portOverride: opts['port'] as number } : {}),
        nonInteractive: jsonMode(),
        ...(installService !== undefined ? { installService } : {}),
      });
      if (jsonMode()) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        const verb = result.created ? 'Wrote' : result.updated ? 'Updated' : 'Verified';
        const lines = [
          `${verb} ${result.configPath}`,
          `Web dashboard: ${result.webBind}:${result.webPort}`,
        ];
        if (result.service) {
          const s = result.service;
          if (s.skipped) {
            lines.push(`Service: skipped (${s.reason ?? 'n/a'})`);
          } else {
            const wrote = s.unitWritten ? 'wrote' : 'unchanged';
            lines.push(`Service: ${wrote} ${s.unitPath}`);
            if (s.enabled === true) {
              lines.push(`Service: enabled + started`);
              if (s.lingerEnabled === false) {
                lines.push(
                  `  Tip: run 'loginctl enable-linger $USER' if you want the daemon to start at boot before you log in.`,
                );
              }
            } else if (s.enabled === false) {
              lines.push(`Service: ${s.enableDetail ?? 'enable failed'}`);
            }
          }
        }
        lines.push(`Next: cd into a project and run 'reder sessions add' to register a session.`);
        process.stdout.write(lines.join('\n') + '\n');
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

sessions
  .command('add [session-id]')
  .description('register a session in this project (writes .mcp.json, adds to config)')
  .option('--display-name <name>', 'display name for this session')
  .option('--project-dir <path>', 'project directory to write .mcp.json into', process.cwd())
  .option('--shim-command <cmd>', 'command to invoke reder-shim', 'reder-shim')
  .option('--auto-start', 'mark session auto_start=true and start the daemon now', false)
  .option(
    '--permission-mode <mode>',
    'Claude permission mode: default | plan | acceptEdits | auto | dontAsk | bypassPermissions',
  )
  .option('--force-rebind', 'rebind an existing session without prompting', false)
  .option('-y, --yes', 'accept all defaults (non-interactive)', false)
  .action(async (sessionIdArg: string | undefined, opts: Record<string, unknown>) => {
    try {
      const permissionMode =
        opts['permissionMode'] !== undefined
          ? validatePermissionMode(opts['permissionMode'] as string)
          : undefined;
      const result = await interactiveSessionAdd({
        ...(sessionIdArg !== undefined ? { sessionIdArg } : {}),
        ...(opts['displayName'] !== undefined
          ? { displayName: opts['displayName'] as string }
          : {}),
        projectDir: opts['projectDir'] as string,
        configPath: configArg(),
        shimCommand: [opts['shimCommand'] as string],
        autoStart: Boolean(opts['autoStart']),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
        forceRebind: Boolean(opts['forceRebind']),
        yes: Boolean(opts['yes']),
        nonInteractive: jsonMode() || Boolean(opts['yes']),
      });
      if (jsonMode()) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        const lines: string[] = [];
        if (result.yamlCreated) lines.push(`Added session '${result.sessionId}' to config`);
        else if (result.yamlUpdated) lines.push(`Updated session '${result.sessionId}' in config`);
        lines.push(`Permission mode: ${result.permissionMode}`);
        lines.push(`Wrote ${result.mcpJsonPath}${result.tokenRotated ? ' (token rotated)' : ''}`);
        if (result.daemonStart) {
          lines.push(`Daemon: ${result.daemonStart.ok ? '✓' : '•'} ${result.daemonStart.detail}`);
        }
        process.stdout.write(lines.join('\n') + '\n');
      }
    } catch (err) {
      fail(err);
    }
  });

sessions
  .command('remove <session-id>')
  .description('remove a session (YAML entry, DB row, project .mcp.json)')
  .option('-y, --yes', 'skip confirmation prompt', false)
  .option('--keep-mcp', 'do not modify .mcp.json in the session workspace', false)
  .action(async (sessionId: string, opts: Record<string, unknown>) => {
    try {
      const result = await interactiveSessionRemove({
        sessionId,
        configPath: configArg(),
        keepMcp: Boolean(opts['keepMcp']),
        yes: Boolean(opts['yes']),
      });
      if ('cancelled' in result) {
        if (jsonMode()) process.stdout.write(JSON.stringify({ cancelled: true }) + '\n');
        else process.stdout.write('cancelled\n');
        return;
      }
      if (jsonMode()) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        const lines = [
          `Removed session '${result.sessionId}'`,
          `  YAML entry: ${result.yamlRemoved ? '✓' : '—'}`,
          `  DB row: ${result.dbRemoved ? '✓' : '—'}${result.bindingsRemoved > 0 ? ` (${result.bindingsRemoved} bindings)` : ''}`,
          `  .mcp.json: ${result.mcpEntryRemoved ? '✓' : '—'}${result.mcpJsonPath ? ` (${result.mcpJsonPath})` : ''}`,
        ];
        for (const w of result.warnings) lines.push(`  warning: ${w}`);
        process.stdout.write(lines.join('\n') + '\n');
      }
    } catch (err) {
      fail(err);
    }
  });

sessions
  .command('repair <session-id>')
  .description('re-write .mcp.json and .claude/settings.local.json for a registered session')
  .action(async (sessionId: string) => {
    try {
      const result = await runSessionRepair({ sessionId, ...buildCfgOpts() });
      if (jsonMode()) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        const lines = [
          `Repaired session '${result.sessionId}' (workspace ${result.workspaceDir})`,
          `  .mcp.json: ${result.mcpJsonPath}${result.tokenRotated ? ' (token rotated)' : ''}`,
        ];
        process.stdout.write(lines.join('\n') + '\n');
      }
    } catch (err) {
      fail(err);
    }
  });

const telegram = program.command('telegram').description('manage Telegram bots and access control');

const telegramBot = telegram.command('bot').description('per-session bot tokens');
telegramBot
  .command('add <session-id>')
  .description('attach a Telegram bot token to a session (writes token inline into config)')
  .option('--token <value>', 'bot token (prompts if omitted)')
  .option(
    '--token-env <name>',
    'reference an externally-set env var instead of storing the token inline',
  )
  .action(async (sessionId: string, opts: Record<string, unknown>) => {
    try {
      const result = await runTelegramBotAdd({
        sessionId,
        configPath: configArg(),
        ...(opts['token'] !== undefined ? { token: opts['token'] as string } : {}),
        ...(opts['tokenEnv'] !== undefined ? { tokenEnv: opts['tokenEnv'] as string } : {}),
        nonInteractive: jsonMode(),
      });
      if (jsonMode()) process.stdout.write(JSON.stringify(result) + '\n');
      else process.stdout.write(formatTelegramBotAdd(result) + '\n');
    } catch (err) {
      fail(err);
    }
  });

telegramBot
  .command('remove <session-id>')
  .description("remove a session's Telegram bot entry")
  .action((sessionId: string) => {
    try {
      const result = runTelegramBotRemove({ sessionId, configPath: configArg() });
      if (jsonMode()) process.stdout.write(JSON.stringify(result) + '\n');
      else process.stdout.write(formatTelegramBotRemove(result) + '\n');
      process.exit(result.removed ? 0 : 1);
    } catch (err) {
      fail(err);
    }
  });

telegramBot
  .command('list')
  .description('list configured Telegram bots')
  .action(() => {
    try {
      const result = runTelegramBotList({ configPath: configArg() });
      if (jsonMode()) process.stdout.write(JSON.stringify(result) + '\n');
      else process.stdout.write(formatTelegramBotList(result) + '\n');
    } catch (err) {
      fail(err);
    }
  });

const telegramAllow = telegram
  .command('allow')
  .description('global allowlist of Telegram user ids');
telegramAllow
  .command('add <user-id>')
  .description('add a numeric Telegram user_id to the global allowlist')
  .action((userId: string) => {
    try {
      const result = runTelegramAllowAdd({ userId, configPath: configArg() });
      if (jsonMode()) process.stdout.write(JSON.stringify(result) + '\n');
      else process.stdout.write(formatTelegramAllowAdd(result) + '\n');
    } catch (err) {
      fail(err);
    }
  });

telegramAllow
  .command('remove <user-id>')
  .description('remove a Telegram user_id from the global allowlist')
  .action((userId: string) => {
    try {
      const result = runTelegramAllowRemove({ userId, configPath: configArg() });
      if (jsonMode()) process.stdout.write(JSON.stringify(result) + '\n');
      else process.stdout.write(formatTelegramAllowRemove(result) + '\n');
      process.exit(result.removed ? 0 : 1);
    } catch (err) {
      fail(err);
    }
  });

telegramAllow
  .command('list')
  .description('list Telegram user_ids on the global allowlist')
  .action(() => {
    try {
      const result = runTelegramAllowList({ configPath: configArg() });
      if (jsonMode()) process.stdout.write(JSON.stringify(result) + '\n');
      else process.stdout.write(formatTelegramAllowList(result) + '\n');
    } catch (err) {
      fail(err);
    }
  });

telegram
  .command('mode [value]')
  .description('show or set access mode: pairing | allowlist')
  .action((value?: string) => {
    try {
      let set: 'pairing' | 'allowlist' | undefined;
      if (value !== undefined) {
        if (value !== 'pairing' && value !== 'allowlist') {
          throw new Error(`mode must be 'pairing' or 'allowlist' (got '${value}')`);
        }
        set = value;
      }
      const result = runTelegramMode({
        configPath: configArg(),
        ...(set !== undefined ? { set } : {}),
      });
      if (jsonMode()) process.stdout.write(JSON.stringify(result) + '\n');
      else process.stdout.write(formatTelegramMode(result) + '\n');
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

function validatePermissionMode(value: string): PermissionMode {
  if ((PERMISSION_MODES as readonly string[]).includes(value)) {
    return value as PermissionMode;
  }
  throw new Error(
    `--permission-mode must be one of ${PERMISSION_MODES.join(', ')} (got '${value}')`,
  );
}

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
