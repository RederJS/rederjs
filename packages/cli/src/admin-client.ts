import { createConnection } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encode, FrameDecoder } from '@rederjs/core/ipc/codec';
import { DaemonToShim } from '@rederjs/core/ipc/protocol';

export interface McpJsonEntry {
  command: string;
  args: string[];
}

export interface McpJson {
  mcpServers: Record<string, McpJsonEntry>;
}

export interface DiscoveredSession {
  sessionId: string;
  token: string;
  socketPath: string;
  projectDir: string;
}

/**
 * Look for .mcp.json in cwd (and parents), extract a reder-shim entry, and
 * parse its --session-id / --token / --socket argv.
 */
export function discoverSessionFromProject(startDir: string): DiscoveredSession | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, '.mcp.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as McpJson;
        for (const [, entry] of Object.entries(parsed.mcpServers ?? {})) {
          const isReder =
            /reder[-_]?shim/i.test(entry.command) ||
            entry.args.some((a) => /reder[-_]?shim/i.test(a));
          if (!isReder) continue;
          const session = findArg(entry.args, '--session-id');
          const token = findArg(entry.args, '--token');
          const socket = findArg(entry.args, '--socket');
          if (session && token && socket) {
            return { sessionId: session, token, socketPath: socket, projectDir: dir };
          }
        }
      } catch {
        // fall through
      }
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

function findArg(args: string[], flag: string): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) return args[i + 1]!;
    const a = args[i]!;
    if (a.startsWith(flag + '=')) return a.slice(flag.length + 1);
  }
  return null;
}

export interface AdminPairResult {
  success: boolean;
  adapter?: string;
  senderId?: string;
  sessionId?: string;
  error?: string;
}

export async function sendAdminPair(
  discovered: DiscoveredSession,
  code: string,
  timeoutMs = 10_000,
): Promise<AdminPairResult> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: discovered.socketPath });
    const decoder = new FrameDecoder();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`timeout waiting for admin_pair_result`));
    }, timeoutMs);

    socket.once('connect', () => {
      socket.write(
        encode({
          kind: 'hello',
          session_id: discovered.sessionId,
          shim_token: discovered.token,
          shim_version: 'reder-cli/0.1.0',
          claude_code_version: 'cli',
        }),
      );
    });
    socket.on('data', (chunk: Buffer) => {
      for (const raw of decoder.push(chunk)) {
        const parsed = DaemonToShim.safeParse(raw);
        if (!parsed.success) continue;
        const msg = parsed.data;
        if (msg.kind === 'welcome') {
          socket.write(encode({ kind: 'admin_pair_request', code: code.toLowerCase() }));
          return;
        }
        if (msg.kind === 'admin_pair_result') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.end();
          const out: AdminPairResult = { success: msg.success };
          if (msg.adapter !== undefined) out.adapter = msg.adapter;
          if (msg.sender_id !== undefined) out.senderId = msg.sender_id;
          if (msg.session_id !== undefined) out.sessionId = msg.session_id;
          if (msg.error !== undefined) out.error = msg.error;
          resolve(out);
          return;
        }
        if (msg.kind === 'error') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`${msg.code}: ${msg.message}`));
          return;
        }
      }
    });
    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function fetchHealth(url: string, timeoutMs = 3000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`health endpoint returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
