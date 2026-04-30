import { statSync } from 'node:fs';
import { Router as expressRouter, type Request, type Response } from 'express';
import type { Database as Db } from 'better-sqlite3';
import type { Logger } from 'pino';
import type {
  RouterHandle,
  AdapterStorage,
  SessionActivityChangedPayload,
} from '@rederjs/core/adapter';
import { listSessions } from '@rederjs/core/sessions';
import { isRunning, startSession } from '@rederjs/core/tmux';
import { listTranscript, getSessionActivity } from '../transcript.js';
import type { SseRegistry } from '../sse.js';
import { getSessionGit } from '../git.js';

export interface SessionConfigEntry {
  session_id: string;
  display_name: string;
  workspace_dir?: string;
  avatar_path?: string;
  auto_start: boolean;
}

function avatarUrl(cfg: SessionConfigEntry): string | null {
  if (!cfg.avatar_path) return null;
  try {
    const stat = statSync(cfg.avatar_path);
    return `/api/sessions/${cfg.session_id}/avatar?v=${Math.floor(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

export interface SessionsRouteDeps {
  db: Db;
  router: RouterHandle;
  logger: Logger;
  sessions: readonly SessionConfigEntry[];
  storage: AdapterStorage;
  sse: SseRegistry;
  adapterName: string;
  senderId: string;
  isSessionConnected: (sessionId: string) => boolean;
}

const UNREAD_KEY = (sessionId: string): string => `unread:${sessionId}`;

async function readUnread(storage: AdapterStorage, sessionId: string): Promise<number> {
  const buf = await storage.get(UNREAD_KEY(sessionId));
  if (!buf) return 0;
  const n = Number(buf.toString('utf8'));
  return Number.isFinite(n) ? n : 0;
}

async function writeUnread(storage: AdapterStorage, sessionId: string, n: number): Promise<void> {
  await storage.set(UNREAD_KEY(sessionId), String(Math.max(0, n)));
}

export async function incrementUnread(storage: AdapterStorage, sessionId: string): Promise<number> {
  const current = await readUnread(storage, sessionId);
  const next = current + 1;
  await writeUnread(storage, sessionId, next);
  return next;
}

export async function clearUnread(storage: AdapterStorage, sessionId: string): Promise<void> {
  await writeUnread(storage, sessionId, 0);
}

export function createSessionsRouter(deps: SessionsRouteDeps): ReturnType<typeof expressRouter> {
  const r = expressRouter();

  r.get('/sessions', async (_req: Request, res: Response) => {
    const dbRows = new Map(listSessions(deps.db).map((s) => [s.session_id, s]));
    const activityByIdRaw = deps.router.listActivity();
    const activityById = new Map(activityByIdRaw.map((a) => [a.sessionId, a]));
    const out = await Promise.all(
      deps.sessions.map(async (cfg) => {
        const row = dbRows.get(cfg.session_id);
        const activity = getSessionActivity(deps.db, cfg.session_id);
        const tmuxRunning = isRunning(cfg.session_id);
        const unread = await readUnread(deps.storage, cfg.session_id);
        const act = activityById.get(cfg.session_id);
        const git = await getSessionGit(cfg.workspace_dir, { logger: deps.logger });
        return {
          session_id: cfg.session_id,
          display_name: cfg.display_name,
          workspace_dir: cfg.workspace_dir ?? null,
          auto_start: cfg.auto_start,
          state: row?.state ?? 'registered',
          last_seen_at: row?.last_seen_at ?? null,
          claude_summary: row?.claude_summary ?? null,
          shim_connected: deps.isSessionConnected(cfg.session_id),
          tmux_running: tmuxRunning,
          last_inbound_at: activity.lastInboundAt,
          last_outbound_at: activity.lastOutboundAt,
          unread,
          activity_state: deriveOverall(act, {
            tmuxRunning,
            shimConnected: deps.isSessionConnected(cfg.session_id),
          }),
          activity_since: act?.since ?? null,
          last_hook: act?.lastHook ?? null,
          last_hook_at: act?.lastHookAt ?? null,
          branch: git.branch,
          pr: git.pr,
          avatar_url: avatarUrl(cfg),
        };
      }),
    );
    res.json({ sessions: out });
  });

  r.get('/sessions/:id', async (req: Request, res: Response) => {
    const cfg = deps.sessions.find((s) => s.session_id === req.params['id']);
    if (!cfg) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const row = listSessions(deps.db).find((s) => s.session_id === cfg.session_id);
    const activity = getSessionActivity(deps.db, cfg.session_id);
    const tmuxRunning = isRunning(cfg.session_id);
    const unread = await readUnread(deps.storage, cfg.session_id);
    const act = deps.router.getActivity(cfg.session_id);
    const git = await getSessionGit(cfg.workspace_dir, { logger: deps.logger });
    res.json({
      session_id: cfg.session_id,
      display_name: cfg.display_name,
      workspace_dir: cfg.workspace_dir ?? null,
      auto_start: cfg.auto_start,
      state: row?.state ?? 'registered',
      last_seen_at: row?.last_seen_at ?? null,
      claude_summary: row?.claude_summary ?? null,
      shim_connected: deps.isSessionConnected(cfg.session_id),
      tmux_running: tmuxRunning,
      last_inbound_at: activity.lastInboundAt,
      last_outbound_at: activity.lastOutboundAt,
      unread,
      activity_state: deriveOverall(act, {
        tmuxRunning,
        shimConnected: deps.isSessionConnected(cfg.session_id),
      }),
      activity_since: act?.since ?? null,
      last_hook: act?.lastHook ?? null,
      last_hook_at: act?.lastHookAt ?? null,
      branch: git.branch,
      pr: git.pr,
      avatar_url: avatarUrl(cfg),
    });
  });

  r.get('/sessions/:id/messages', async (req: Request, res: Response) => {
    const sessionId = req.params['id']!;
    const cfg = deps.sessions.find((s) => s.session_id === sessionId);
    if (!cfg) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const before = typeof req.query['before'] === 'string' ? req.query['before'] : undefined;
    const limitRaw = typeof req.query['limit'] === 'string' ? Number(req.query['limit']) : NaN;
    const messages = listTranscript(deps.db, {
      sessionId,
      ...(before ? { before } : {}),
      ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
    });
    // Reading the transcript clears unread count.
    await clearUnread(deps.storage, sessionId);
    deps.router.notifyUnread(sessionId, 0);
    res.json({ messages });
  });

  r.post('/sessions/:id/messages', async (req: Request, res: Response) => {
    const sessionId = req.params['id']!;
    const cfg = deps.sessions.find((s) => s.session_id === sessionId);
    if (!cfg) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const body = (req.body ?? {}) as {
      content?: unknown;
      files?: unknown;
      meta?: unknown;
    };
    const content = typeof body.content === 'string' ? body.content : '';
    if (content.length === 0 && !Array.isArray(body.files)) {
      res.status(400).json({ error: 'content or files required' });
      return;
    }
    const files: string[] = Array.isArray(body.files)
      ? body.files.filter((f): f is string => typeof f === 'string')
      : [];
    const meta: Record<string, string> = {};
    if (body.meta && typeof body.meta === 'object') {
      for (const [k, v] of Object.entries(body.meta as Record<string, unknown>)) {
        if (typeof v === 'string') meta[k] = v;
      }
    }
    await deps.router.ingestInbound({
      adapter: deps.adapterName,
      sessionId,
      senderId: deps.senderId,
      content,
      meta,
      files,
      receivedAt: new Date(),
    });
    res.status(202).json({ accepted: true });
  });

  r.post('/sessions/:id/start', (req: Request, res: Response) => {
    const sessionId = req.params['id']!;
    const cfg = deps.sessions.find((s) => s.session_id === sessionId);
    if (!cfg) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (!cfg.workspace_dir) {
      res.status(400).json({ error: 'session has no workspace_dir configured' });
      return;
    }
    const result = startSession({
      session_id: cfg.session_id,
      workspace_dir: cfg.workspace_dir,
      logger: deps.logger,
    });
    res.status(result.started ? 201 : 200).json(result);
  });

  return r;
}

function deriveOverall(
  act: SessionActivityChangedPayload | undefined,
  ctx: { tmuxRunning: boolean; shimConnected: boolean },
): 'working' | 'awaiting-user' | 'idle' | 'unknown' | 'offline' {
  // Tmux liveness is owned here (in the adapter) rather than in the router's
  // SessionActivityTracker, because the adapter already polls tmux status for
  // each session on every request. A future refinement could feed tmux state
  // into the tracker via a notifyTmuxRunning() signal; until then, other
  // adapters using router.listActivity()/getActivity() should layer their own
  // tmux check on top if they need "offline" for dead tmux sessions.
  if (!ctx.tmuxRunning) return 'offline';
  if (!ctx.shimConnected) return 'offline';
  return act?.state ?? 'unknown';
}
