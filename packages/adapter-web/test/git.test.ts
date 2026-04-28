import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getSessionGit, invalidateSessionGit, clearSessionGitCache } from '../src/git.js';

let dir: string;
let gitRepo: string;

beforeEach(() => {
  clearSessionGitCache();
  dir = mkdtempSync(join(tmpdir(), 'reder-git-'));
  gitRepo = join(dir, 'repo');
  mkdirSync(gitRepo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: gitRepo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitRepo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitRepo });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: gitRepo });
  writeFileSync(join(gitRepo, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: gitRepo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: gitRepo });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearSessionGitCache();
});

describe('getSessionGit', () => {
  it('returns null branch and pr when workspace_dir is null', async () => {
    const r = await getSessionGit(null);
    expect(r).toEqual({ branch: null, pr: null });
  });

  it('returns null branch and pr when workspace_dir is undefined', async () => {
    const r = await getSessionGit(undefined);
    expect(r).toEqual({ branch: null, pr: null });
  });

  it('returns null branch when not a git repo', async () => {
    const notRepo = join(dir, 'plain');
    mkdirSync(notRepo);
    const r = await getSessionGit(notRepo);
    expect(r.branch).toBeNull();
    expect(r.pr).toBeNull();
  });

  it('reads the current branch from a git repo', async () => {
    const r = await getSessionGit(gitRepo);
    expect(r.branch).toBe('main');
  });

  it('reads a non-default branch after checkout', async () => {
    execFileSync('git', ['checkout', '-q', '-b', 'feat/new-thing'], { cwd: gitRepo });
    const r = await getSessionGit(gitRepo);
    expect(r.branch).toBe('feat/new-thing');
  });

  it('returns null branch when HEAD is detached', async () => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRepo }).toString().trim();
    execFileSync('git', ['checkout', '-q', sha], { cwd: gitRepo });
    const r = await getSessionGit(gitRepo);
    expect(r.branch).toBeNull();
  });

  it('caches results within the TTL', async () => {
    const a = await getSessionGit(gitRepo, { ttlMs: 60_000 });
    execFileSync('git', ['checkout', '-q', '-b', 'changed'], { cwd: gitRepo });
    const b = await getSessionGit(gitRepo, { ttlMs: 60_000 });
    expect(b.branch).toBe(a.branch);
  });

  it('invalidate forces a refresh', async () => {
    await getSessionGit(gitRepo, { ttlMs: 60_000 });
    execFileSync('git', ['checkout', '-q', '-b', 'changed'], { cwd: gitRepo });
    invalidateSessionGit(gitRepo);
    const r = await getSessionGit(gitRepo, { ttlMs: 60_000 });
    expect(r.branch).toBe('changed');
  });

  it('returns null pr when gh has no remote configured', async () => {
    const r = await getSessionGit(gitRepo);
    expect(r.pr).toBeNull();
  });
});
