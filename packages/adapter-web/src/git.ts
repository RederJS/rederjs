import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';

const execFileAsync = promisify(execFile);

export interface PrInfo {
  number: number;
  url: string;
}

export interface SessionGit {
  branch: string | null;
  pr: PrInfo | null;
}

export interface GetSessionGitOptions {
  ttlMs?: number;
  ghTimeoutMs?: number;
  gitTimeoutMs?: number;
  logger?: Logger;
}

interface CacheEntry {
  expiresAt: number;
  value: SessionGit;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_GIT_TIMEOUT_MS = 1_500;
const DEFAULT_GH_TIMEOUT_MS = 4_000;

const cache = new Map<string, CacheEntry>();

export function invalidateSessionGit(workspaceDir: string): void {
  cache.delete(workspaceDir);
}

export function clearSessionGitCache(): void {
  cache.clear();
}

export async function getSessionGit(
  workspaceDir: string | null | undefined,
  opts: GetSessionGitOptions = {},
): Promise<SessionGit> {
  if (!workspaceDir) return { branch: null, pr: null };

  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  const hit = cache.get(workspaceDir);
  if (hit && hit.expiresAt > now) return hit.value;

  const branch = await readBranch(workspaceDir, opts.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS).catch(
    (err) => {
      opts.logger?.debug({ err, workspaceDir }, 'reder.git.branch_failed');
      return null;
    },
  );

  let pr: PrInfo | null = null;
  if (branch) {
    pr = await readPr(workspaceDir, branch, opts.ghTimeoutMs ?? DEFAULT_GH_TIMEOUT_MS).catch(
      (err) => {
        opts.logger?.debug({ err, workspaceDir, branch }, 'reder.git.pr_failed');
        return null;
      },
    );
  }

  const value: SessionGit = { branch, pr };
  cache.set(workspaceDir, { value, expiresAt: now + ttlMs });
  return value;
}

async function readBranch(cwd: string, timeoutMs: number): Promise<string | null> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
  });
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'HEAD') return null;
  return trimmed;
}

async function readPr(cwd: string, branch: string, timeoutMs: number): Promise<PrInfo | null> {
  const { stdout } = await execFileAsync(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '--limit', '1'],
    { cwd, timeout: timeoutMs, windowsHide: true },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first = parsed[0] as { number?: unknown; url?: unknown };
  if (typeof first.number !== 'number' || typeof first.url !== 'string') return null;
  return { number: first.number, url: first.url };
}
