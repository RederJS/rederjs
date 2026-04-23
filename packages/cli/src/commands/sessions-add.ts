import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import prompts from 'prompts';
import { openDatabase } from '@rederjs/core/storage/db';
import { createSession } from '@rederjs/core/sessions';
import type { PermissionMode } from '@rederjs/core/tmux';
import { loadConfigContext } from '../config-loader.js';
import { defaultConfigPath, socketPathFor } from '../paths.js';
import { peekSession, upsertSession } from './config-writer.js';
import { runStart, type ServiceResult } from './service.js';
import { sanitizeSessionId, validateSessionId, prettifyDisplayName } from '../session-id.js';
import { installClaudeHooks } from './claude-hooks.js';

const PERMISSION_MODE_CHOICES: ReadonlyArray<{ title: string; value: PermissionMode }> = [
  { title: 'default — ask before each tool use', value: 'default' },
  { title: 'plan — read-only planning, no edits', value: 'plan' },
  { title: 'acceptEdits — auto-approve file edits', value: 'acceptEdits' },
  { title: 'auto — classifier-driven auto-permission (see `claude auto-mode`)', value: 'auto' },
  { title: 'dontAsk — skip permission prompts', value: 'dontAsk' },
  { title: 'bypassPermissions — bypass all permission checks', value: 'bypassPermissions' },
];

function resolveHookCommand(): string {
  // Claude Code runs hooks via /bin/sh -c, which may not have npm's global bin
  // on PATH (systemd user services, desktop-launched Claude, etc.). Resolve to
  // an absolute path at install time so the hook works regardless of the
  // shell's PATH. Fall back to bare 'reder-hook' if resolution fails.
  // Static argv (no user input) — no injection surface.
  try {
    const out = execFileSync('/usr/bin/env', ['which', 'reder-hook'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out.length > 0 && out.startsWith('/')) return out;
  } catch {
    // `which` not found or reder-hook not on PATH at install time.
  }
  return 'reder-hook';
}

export class ConfigNotFoundError extends Error {
  override readonly name = 'ConfigNotFoundError';
  constructor(public readonly configPath: string) {
    super(`No config found at ${configPath}. Run 'reder init' first.`);
  }
}

export class SessionWorkspaceMismatchError extends Error {
  override readonly name = 'SessionWorkspaceMismatchError';
  constructor(
    public readonly sessionId: string,
    public readonly existingWorkspaceDir: string,
    public readonly proposedWorkspaceDir: string,
  ) {
    super(
      `Session '${sessionId}' is already bound to ${existingWorkspaceDir}; refusing to rebind to ${proposedWorkspaceDir} without --force-rebind`,
    );
  }
}

export class InvalidSessionIdError extends Error {
  override readonly name = 'InvalidSessionIdError';
}

export interface SessionAddOptions {
  sessionId: string;
  displayName?: string | undefined;
  projectDir?: string | undefined;
  configPath?: string | undefined;
  shimCommand?: readonly string[] | undefined;
  autoStart?: boolean | undefined;
  permissionMode?: PermissionMode | undefined;
  forceRebind?: boolean | undefined;
}

export interface SessionAddResult {
  sessionId: string;
  displayName: string;
  workspaceDir: string;
  configPath: string;
  mcpJsonPath: string;
  socketPath: string;
  tokenRotated: boolean;
  yamlCreated: boolean;
  yamlUpdated: boolean;
  autoStart: boolean;
  permissionMode: PermissionMode;
  daemonStart?: ServiceResult;
}

interface McpServersFile {
  mcpServers?: Record<string, { command: string; args: string[] }>;
}

export async function runSessionAdd(opts: SessionAddOptions): Promise<SessionAddResult> {
  const configPath = opts.configPath ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new ConfigNotFoundError(configPath);
  }

  const valid = validateSessionId(opts.sessionId);
  if (valid !== true) {
    throw new InvalidSessionIdError(valid);
  }

  const displayName = opts.displayName ?? prettifyDisplayName(opts.sessionId);
  const projectDir = resolve(opts.projectDir ?? process.cwd());
  const autoStart = opts.autoStart ?? false;

  const existing = peekSession({ configPath, sessionId: opts.sessionId });
  const permissionMode: PermissionMode =
    opts.permissionMode ?? existing?.permission_mode ?? 'default';
  if (
    existing &&
    existing.workspace_dir !== undefined &&
    existing.workspace_dir !== projectDir &&
    !opts.forceRebind
  ) {
    throw new SessionWorkspaceMismatchError(opts.sessionId, existing.workspace_dir, projectDir);
  }

  const upsert = upsertSession({
    configPath,
    sessionId: opts.sessionId,
    displayName,
    workspaceDir: projectDir,
    autoStart,
    permissionMode,
  });
  const yamlCreated = upsert.kind === 'created';
  const yamlUpdated = upsert.kind !== 'updated_same';

  const ctx = loadConfigContext(configPath);
  mkdirSync(ctx.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(ctx.runtimeDir, { recursive: true, mode: 0o700 });

  const db = openDatabase(join(ctx.dataDir, 'reder.db'));
  let mcpJsonPath: string;
  let socketPath: string;
  let tokenRotated: boolean;
  try {
    const { token, created } = await createSession(db.raw, opts.sessionId, displayName);
    mcpJsonPath = join(projectDir, '.mcp.json');

    let doc: McpServersFile = {};
    if (existsSync(mcpJsonPath)) {
      try {
        doc = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as McpServersFile;
      } catch {
        throw new Error(`${mcpJsonPath} exists but is not valid JSON; refusing to overwrite`);
      }
    }
    if (!doc.mcpServers) doc.mcpServers = {};

    socketPath = socketPathFor(ctx.runtimeDir);
    const command = opts.shimCommand ?? ['reder-shim'];
    doc.mcpServers['reder'] = {
      command: command[0]!,
      args: [
        ...command.slice(1),
        '--session-id',
        opts.sessionId,
        '--token',
        token,
        '--socket',
        socketPath,
      ],
    };

    writeFileSync(mcpJsonPath, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    chmodSync(mcpJsonPath, 0o600);

    try {
      installClaudeHooks({
        projectDir,
        sessionId: opts.sessionId,
        hookCommand: resolveHookCommand(),
        socketPath,
        token,
      });
    } catch (err) {
      // Non-fatal — the session is still registered. `reder sessions repair` can
      // recover from this. Surface the warning to stderr so it's not silent.
      process.stderr.write(
        `warning: failed to install Claude hooks in ${projectDir}/.claude: ${(err as Error).message}\n`,
      );
    }

    tokenRotated = !created;
  } finally {
    db.close();
  }

  const result: SessionAddResult = {
    sessionId: opts.sessionId,
    displayName,
    workspaceDir: projectDir,
    configPath,
    mcpJsonPath,
    socketPath,
    tokenRotated,
    yamlCreated,
    yamlUpdated,
    autoStart,
    permissionMode,
  };

  if (autoStart) {
    result.daemonStart = runStart({ configPath });
  }

  return result;
}

export interface InteractiveSessionAddOptions {
  sessionIdArg?: string | undefined;
  displayName?: string | undefined;
  projectDir?: string | undefined;
  configPath?: string | undefined;
  shimCommand?: readonly string[] | undefined;
  autoStart?: boolean | undefined;
  permissionMode?: PermissionMode | undefined;
  forceRebind?: boolean | undefined;
  yes?: boolean | undefined;
  nonInteractive?: boolean | undefined;
}

export async function interactiveSessionAdd(
  opts: InteractiveSessionAddOptions,
): Promise<SessionAddResult> {
  const configPath = opts.configPath ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new ConfigNotFoundError(configPath);
  }

  const projectDir = resolve(opts.projectDir ?? process.cwd());
  const canInteract = !opts.nonInteractive && !opts.yes && Boolean(process.stdin.isTTY);
  const positionalMode = opts.sessionIdArg !== undefined && opts.sessionIdArg.length > 0;

  let sessionId: string;
  let displayName: string | undefined = opts.displayName;
  let autoStart: boolean = opts.autoStart ?? false;
  let permissionMode: PermissionMode | undefined = opts.permissionMode;

  if (positionalMode) {
    sessionId = sanitizeSessionId(opts.sessionIdArg!);
  } else if (!canInteract) {
    sessionId = sanitizeSessionId(basename(projectDir));
  } else {
    const defaultId = sanitizeSessionId(basename(projectDir)) || 'default';
    const { sid } = (await prompts({
      type: 'text',
      name: 'sid',
      message: 'Session id',
      initial: defaultId,
      validate: (v: string) => {
        const r = validateSessionId(v);
        return r === true ? true : r;
      },
    })) as { sid?: string };
    if (sid === undefined) throw new Error('cancelled');
    sessionId = sid;

    const { name } = (await prompts({
      type: 'text',
      name: 'name',
      message: 'Display name',
      initial: displayName ?? prettifyDisplayName(sessionId),
    })) as { name?: string };
    if (name === undefined) throw new Error('cancelled');
    displayName = name;

    const existing = peekSession({ configPath, sessionId });
    const modeInitial: PermissionMode = permissionMode ?? existing?.permission_mode ?? 'default';
    const { mode } = (await prompts({
      type: 'select',
      name: 'mode',
      message: 'Claude permission mode',
      choices: PERMISSION_MODE_CHOICES.map((c) => ({ title: c.title, value: c.value })),
      initial: PERMISSION_MODE_CHOICES.findIndex((c) => c.value === modeInitial),
    })) as { mode?: PermissionMode };
    if (mode === undefined) throw new Error('cancelled');
    permissionMode = mode;

    const { start } = (await prompts({
      type: 'confirm',
      name: 'start',
      message: 'Auto-start this session with the daemon?',
      initial: autoStart,
    })) as { start?: boolean };
    if (start === undefined) throw new Error('cancelled');
    autoStart = start;
  }

  try {
    return await runSessionAdd({
      sessionId,
      ...(displayName !== undefined ? { displayName } : {}),
      projectDir,
      configPath,
      ...(opts.shimCommand !== undefined ? { shimCommand: opts.shimCommand } : {}),
      autoStart,
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(opts.forceRebind !== undefined ? { forceRebind: opts.forceRebind } : {}),
    });
  } catch (err) {
    if (err instanceof SessionWorkspaceMismatchError && canInteract) {
      return handleCollision(err, {
        sessionId,
        displayName,
        projectDir,
        configPath,
        shimCommand: opts.shimCommand,
        autoStart,
        permissionMode,
      });
    }
    throw err;
  }
}

async function handleCollision(
  err: SessionWorkspaceMismatchError,
  base: {
    sessionId: string;
    displayName: string | undefined;
    projectDir: string;
    configPath: string;
    shimCommand: readonly string[] | undefined;
    autoStart: boolean;
    permissionMode: PermissionMode | undefined;
  },
): Promise<SessionAddResult> {
  const { choice } = (await prompts({
    type: 'select',
    name: 'choice',
    message:
      `Session '${err.sessionId}' is already bound to ${err.existingWorkspaceDir}.\n` +
      `Current cwd: ${err.proposedWorkspaceDir}`,
    choices: [
      { title: 'Rebind to current directory', value: 'rebind' },
      { title: 'Use a different session id for this project', value: 'rename' },
      { title: 'Cancel', value: 'cancel' },
    ],
    initial: 0,
  })) as { choice?: string };

  if (choice === 'rebind') {
    return runSessionAdd({
      sessionId: base.sessionId,
      ...(base.displayName !== undefined ? { displayName: base.displayName } : {}),
      projectDir: base.projectDir,
      configPath: base.configPath,
      ...(base.shimCommand !== undefined ? { shimCommand: base.shimCommand } : {}),
      autoStart: base.autoStart,
      ...(base.permissionMode !== undefined ? { permissionMode: base.permissionMode } : {}),
      forceRebind: true,
    });
  }

  if (choice === 'rename') {
    const { sid } = (await prompts({
      type: 'text',
      name: 'sid',
      message: 'New session id',
      validate: (v: string) => {
        const r = validateSessionId(v);
        return r === true ? true : r;
      },
    })) as { sid?: string };
    if (sid === undefined) throw new Error('cancelled');
    return runSessionAdd({
      sessionId: sid,
      ...(base.displayName !== undefined ? { displayName: base.displayName } : {}),
      projectDir: base.projectDir,
      configPath: base.configPath,
      ...(base.shimCommand !== undefined ? { shimCommand: base.shimCommand } : {}),
      autoStart: base.autoStart,
      ...(base.permissionMode !== undefined ? { permissionMode: base.permissionMode } : {}),
    });
  }

  throw err;
}
