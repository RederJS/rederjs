import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '@rederjs/core/storage/db';
import { createSession } from '@rederjs/core/sessions';
import { loadConfigContext } from '../config-loader.js';
import { socketPathFor } from '../paths.js';

export interface InstallOptions {
  sessionId: string;
  displayName?: string | undefined;
  projectDir?: string | undefined;
  configPath?: string | undefined;
  shimCommand?: readonly string[] | undefined;
}

export interface InstallResult {
  sessionId: string;
  mcpJsonPath: string;
  socketPath: string;
  tokenRotated: boolean;
}

interface McpServersFile {
  mcpServers?: Record<string, { command: string; args: string[] }>;
}

export async function runInstall(opts: InstallOptions): Promise<InstallResult> {
  const ctx = loadConfigContext(opts.configPath);
  mkdirSync(ctx.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(ctx.runtimeDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(ctx.dataDir, 'reder.db'));
  try {
    const { token, created } = await createSession(
      db.raw,
      opts.sessionId,
      opts.displayName ?? opts.sessionId,
    );

    const projectDir = resolve(opts.projectDir ?? process.cwd());
    const mcpJsonPath = join(projectDir, '.mcp.json');

    let doc: McpServersFile = {};
    if (existsSync(mcpJsonPath)) {
      try {
        doc = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as McpServersFile;
      } catch {
        throw new Error(`${mcpJsonPath} exists but is not valid JSON; refusing to overwrite`);
      }
    }
    if (!doc.mcpServers) doc.mcpServers = {};

    const socketPath = socketPathFor(ctx.runtimeDir);
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

    return {
      sessionId: opts.sessionId,
      mcpJsonPath,
      socketPath,
      tokenRotated: !created,
    };
  } finally {
    db.close();
  }
}
