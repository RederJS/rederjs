import { discoverSessionFromProject, sendAdminPair, type AdminPairResult } from '../admin-client.js';

export interface PairOptions {
  code: string;
  projectDir?: string;
}

export async function runPair(opts: PairOptions): Promise<AdminPairResult> {
  const discovered = discoverSessionFromProject(opts.projectDir ?? process.cwd());
  if (!discovered) {
    throw new Error(
      'No .mcp.json with a reder-shim entry found in this project or any parent. Run `reder install <session-id>` first.',
    );
  }
  return sendAdminPair(discovered, opts.code);
}

export function formatPairResult(r: AdminPairResult): string {
  if (r.success) {
    return `✅ Paired ${r.adapter} sender ${r.senderId ?? ''} to session ${r.sessionId ?? ''}`;
  }
  return `❌ Pairing failed: ${r.error ?? 'unknown error'}`;
}
