import { existsSync } from 'node:fs';
import { loadConfigContext } from '../config-loader.js';
import { defaultConfigPath } from '../paths.js';
import { peekSession } from './config-writer.js';
import { runSessionAdd, ConfigNotFoundError, type SessionAddResult } from './sessions-add.js';
import { SessionNotFoundError } from './sessions-remove.js';

export interface SessionRepairOptions {
  sessionId: string;
  configPath?: string | undefined;
  shimCommand?: readonly string[] | undefined;
}

export async function runSessionRepair(opts: SessionRepairOptions): Promise<SessionAddResult> {
  const configPath = opts.configPath ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new ConfigNotFoundError(configPath);
  }
  const existing = peekSession({ configPath, sessionId: opts.sessionId });
  if (!existing) throw new SessionNotFoundError(opts.sessionId);
  if (!existing.workspace_dir) {
    throw new Error(
      `Session '${opts.sessionId}' has no workspace_dir; nothing to repair (add one first).`,
    );
  }
  // Load context just to validate it parses cleanly.
  loadConfigContext(configPath);

  return runSessionAdd({
    sessionId: opts.sessionId,
    displayName: existing.display_name,
    projectDir: existing.workspace_dir,
    configPath,
    ...(opts.shimCommand !== undefined ? { shimCommand: opts.shimCommand } : {}),
    autoStart: existing.auto_start ?? false,
    ...(existing.permission_mode !== undefined ? { permissionMode: existing.permission_mode } : {}),
    forceRebind: true,
  });
}
