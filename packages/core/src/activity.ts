import { EventEmitter } from 'node:events';

export type ActivityState = 'working' | 'awaiting-user' | 'idle' | 'unknown' | 'offline';

export type HookName = 'SessionStart' | 'UserPromptSubmit' | 'Stop' | 'SessionEnd';

export interface SessionActivitySnapshot {
  sessionId: string;
  state: ActivityState;
  since: string; // ISO of the last transition
  lastHook?: HookName;
  lastHookAt?: string;
}

interface InternalState {
  state: ActivityState;
  since: string;
  lastHook?: HookName;
  lastHookAt?: string;
  pendingPermissions: Set<string>;
  unread: number;
  shimConnected: boolean;
  hasSeenHook: boolean;
  seenStopSinceLastPrompt: boolean;
}

export interface HookEventInput {
  sessionId: string;
  hook: HookName;
  timestamp: string;
}

export interface ActivityChangeListener {
  (snapshot: SessionActivitySnapshot): void;
}

export class SessionActivityTracker {
  private readonly states = new Map<string, InternalState>();
  private readonly emitter = new EventEmitter();

  on(event: 'changed', listener: ActivityChangeListener): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  off(event: 'changed', listener: ActivityChangeListener): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  get(sessionId: string): SessionActivitySnapshot | undefined {
    const s = this.states.get(sessionId);
    if (!s) return undefined;
    return this.snapshot(sessionId, s);
  }

  list(): SessionActivitySnapshot[] {
    return Array.from(this.states.entries()).map(([id, s]) => this.snapshot(id, s));
  }

  onShimConnected(sessionId: string): void {
    const s = this.ensure(sessionId);
    s.shimConnected = true;
    this.recompute(sessionId, s);
  }

  onShimDisconnected(sessionId: string): void {
    const s = this.ensure(sessionId);
    s.shimConnected = false;
    s.hasSeenHook = false;
    s.seenStopSinceLastPrompt = false;
    // Preserve lastHook/lastHookAt as historical metadata — callers may still
    // want to know "the last hook we ever saw for this session".
    this.recompute(sessionId, s);
  }

  onHookEvent(evt: HookEventInput): void {
    const s = this.ensure(evt.sessionId);
    s.lastHook = evt.hook;
    s.lastHookAt = evt.timestamp;
    s.hasSeenHook = true;
    if (evt.hook === 'UserPromptSubmit') {
      s.seenStopSinceLastPrompt = false;
    } else if (evt.hook === 'Stop' || evt.hook === 'SessionEnd' || evt.hook === 'SessionStart') {
      // SessionStart fires on startup/resume/clear — Claude just came up and is
      // idle waiting for input, not working. Treating it like Stop makes a
      // freshly-restarted session derive to `idle`, not `working`.
      s.seenStopSinceLastPrompt = true;
    }
    this.recompute(evt.sessionId, s);
  }

  onPermissionRequested(sessionId: string, requestId: string): void {
    const s = this.ensure(sessionId);
    s.pendingPermissions.add(requestId);
    this.recompute(sessionId, s);
  }

  onPermissionResolved(sessionId: string, requestId: string): void {
    const s = this.ensure(sessionId);
    s.pendingPermissions.delete(requestId);
    this.recompute(sessionId, s);
  }

  onUnreadChanged(sessionId: string, unread: number): void {
    const s = this.ensure(sessionId);
    s.unread = Math.max(0, unread);
    this.recompute(sessionId, s);
  }

  forget(sessionId: string): void {
    this.states.delete(sessionId);
  }

  private ensure(sessionId: string): InternalState {
    const existing = this.states.get(sessionId);
    if (existing) return existing;
    const fresh: InternalState = {
      state: 'offline',
      since: new Date().toISOString(),
      pendingPermissions: new Set(),
      unread: 0,
      shimConnected: false,
      hasSeenHook: false,
      seenStopSinceLastPrompt: false,
    };
    this.states.set(sessionId, fresh);
    return fresh;
  }

  private derive(s: InternalState): ActivityState {
    if (!s.shimConnected) return 'offline';
    if (!s.hasSeenHook) return 'unknown';
    if (!s.seenStopSinceLastPrompt) return 'working';
    if (s.pendingPermissions.size > 0 || s.unread > 0) return 'awaiting-user';
    return 'idle';
  }

  private recompute(sessionId: string, s: InternalState): void {
    const next = this.derive(s);
    if (s.state === next) return;
    s.state = next;
    s.since = new Date().toISOString();
    this.emitter.emit('changed', this.snapshot(sessionId, s));
  }

  private snapshot(sessionId: string, s: InternalState): SessionActivitySnapshot {
    const out: SessionActivitySnapshot = {
      sessionId,
      state: s.state,
      since: s.since,
    };
    if (s.lastHook !== undefined) out.lastHook = s.lastHook;
    if (s.lastHookAt !== undefined) out.lastHookAt = s.lastHookAt;
    return out;
  }
}
