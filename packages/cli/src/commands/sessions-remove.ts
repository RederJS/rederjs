import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import prompts from 'prompts';
import { openDatabase } from '@rederjs/core/storage/db';
import { deleteSession } from '@rederjs/core/sessions';
import { loadConfigContext } from '../config-loader.js';
import { defaultConfigPath } from '../paths.js';
import { peekSession, removeSession } from './config-writer.js';
import { ConfigNotFoundError } from './sessions-add.js';
import { removeClaudeHooks } from './claude-hooks.js';

export class SessionNotFoundError extends Error {
  override readonly name = 'SessionNotFoundError';
  constructor(public readonly sessionId: string) {
    super(`Session '${sessionId}' not found in config`);
  }
}

export interface SessionRemoveOptions {
  sessionId: string;
  configPath?: string | undefined;
  keepMcp?: boolean | undefined;
}

export interface SessionRemoveResult {
  sessionId: string;
  workspaceDir: string | undefined;
  yamlRemoved: boolean;
  dbRemoved: boolean;
  bindingsRemoved: number;
  mcpJsonPath: string | undefined;
  mcpEntryRemoved: boolean;
  warnings: string[];
}

interface McpServersFile {
  mcpServers?: Record<string, unknown>;
}

export function runSessionRemove(opts: SessionRemoveOptions): SessionRemoveResult {
  const configPath = opts.configPath ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new ConfigNotFoundError(configPath);
  }

  const existing = peekSession({ configPath, sessionId: opts.sessionId });
  if (!existing) {
    throw new SessionNotFoundError(opts.sessionId);
  }

  const warnings: string[] = [];
  const ctx = loadConfigContext(configPath);

  let dbRemoved = false;
  let bindingsRemoved = 0;
  const db = openDatabase(join(ctx.dataDir, 'reder.db'));
  try {
    const r = deleteSession(db.raw, opts.sessionId);
    dbRemoved = r.deleted;
    bindingsRemoved = r.bindings_removed;
  } finally {
    db.close();
  }

  let mcpJsonPath: string | undefined;
  let mcpEntryRemoved = false;
  if (!opts.keepMcp && existing.workspace_dir !== undefined) {
    mcpJsonPath = join(existing.workspace_dir, '.mcp.json');
    try {
      if (!existsSync(existing.workspace_dir)) {
        warnings.push(`workspace_dir does not exist: ${existing.workspace_dir}`);
      } else if (existsSync(mcpJsonPath) && statSync(mcpJsonPath).isFile()) {
        const doc = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as McpServersFile;
        if (doc.mcpServers && 'reder' in doc.mcpServers) {
          delete doc.mcpServers.reder;
          writeFileSync(mcpJsonPath, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
          mcpEntryRemoved = true;
        }
      }
    } catch (err) {
      warnings.push(`failed to update ${mcpJsonPath}: ${(err as Error).message}`);
    }

    try {
      if (existsSync(existing.workspace_dir)) {
        removeClaudeHooks({
          projectDir: existing.workspace_dir,
          sessionId: opts.sessionId,
        });
      }
    } catch (err) {
      warnings.push(
        `failed to strip Claude hooks in ${existing.workspace_dir}/.claude: ${(err as Error).message}`,
      );
    }
  }

  const { removed: yamlRemoved } = removeSession({ configPath, sessionId: opts.sessionId });

  return {
    sessionId: opts.sessionId,
    workspaceDir: existing.workspace_dir,
    yamlRemoved,
    dbRemoved,
    bindingsRemoved,
    mcpJsonPath,
    mcpEntryRemoved,
    warnings,
  };
}

export interface InteractiveSessionRemoveOptions {
  sessionId: string;
  configPath?: string | undefined;
  keepMcp?: boolean | undefined;
  yes?: boolean | undefined;
}

export async function interactiveSessionRemove(
  opts: InteractiveSessionRemoveOptions,
): Promise<SessionRemoveResult | { cancelled: true }> {
  const configPath = opts.configPath ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new ConfigNotFoundError(configPath);
  }
  const existing = peekSession({ configPath, sessionId: opts.sessionId });
  if (!existing) {
    throw new SessionNotFoundError(opts.sessionId);
  }

  const canInteract = !opts.yes && Boolean(process.stdin.isTTY);
  if (canInteract) {
    const targets: string[] = [
      `- YAML session entry '${opts.sessionId}'`,
      `- SQLite session row (and any bindings)`,
    ];
    if (!opts.keepMcp && existing.workspace_dir !== undefined) {
      targets.push(`- reder entry in ${existing.workspace_dir}/.mcp.json`);
    }
    const { ok } = (await prompts({
      type: 'confirm',
      name: 'ok',
      message: `Remove:\n${targets.join('\n')}\nProceed?`,
      initial: false,
    })) as { ok?: boolean };
    if (!ok) return { cancelled: true };
  }

  return runSessionRemove({
    sessionId: opts.sessionId,
    configPath,
    ...(opts.keepMcp !== undefined ? { keepMcp: opts.keepMcp } : {}),
  });
}
