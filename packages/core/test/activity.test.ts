import { describe, it, expect, beforeEach } from 'vitest';
import {
  SessionActivityTracker,
  type ActivityState,
  type SessionActivitySnapshot,
} from '../src/activity.js';

let tracker: SessionActivityTracker;
let emissions: Array<{ sessionId: string; state: ActivityState }>;

beforeEach(() => {
  tracker = new SessionActivityTracker();
  emissions = [];
  tracker.on('changed', (snap: SessionActivitySnapshot) => {
    emissions.push({ sessionId: snap.sessionId, state: snap.state });
  });
});

describe('SessionActivityTracker', () => {
  it('starts a session in unknown when shim connects with no prior hooks', () => {
    tracker.onShimConnected('s1');
    expect(tracker.get('s1')?.state).toBe('unknown');
    expect(emissions).toEqual([{ sessionId: 's1', state: 'unknown' }]);
  });

  it('transitions to working on UserPromptSubmit', () => {
    tracker.onShimConnected('s1');
    tracker.onHookEvent({ sessionId: 's1', hook: 'UserPromptSubmit', timestamp: '2026-04-22T12:00:00Z' });
    expect(tracker.get('s1')?.state).toBe('working');
  });

  it('transitions to idle on Stop with no unread and no pending permission', () => {
    tracker.onShimConnected('s1');
    tracker.onHookEvent({ sessionId: 's1', hook: 'UserPromptSubmit', timestamp: '2026-04-22T12:00:00Z' });
    tracker.onHookEvent({ sessionId: 's1', hook: 'Stop', timestamp: '2026-04-22T12:01:00Z' });
    expect(tracker.get('s1')?.state).toBe('idle');
  });

  it('transitions to awaiting-user on Stop with unread > 0', () => {
    tracker.onShimConnected('s1');
    tracker.onUnreadChanged('s1', 2);
    tracker.onHookEvent({ sessionId: 's1', hook: 'UserPromptSubmit', timestamp: '2026-04-22T12:00:00Z' });
    tracker.onHookEvent({ sessionId: 's1', hook: 'Stop', timestamp: '2026-04-22T12:01:00Z' });
    expect(tracker.get('s1')?.state).toBe('awaiting-user');
  });

  it('transitions to awaiting-user on Stop with pending permission', () => {
    tracker.onShimConnected('s1');
    tracker.onHookEvent({ sessionId: 's1', hook: 'UserPromptSubmit', timestamp: '2026-04-22T12:00:00Z' });
    tracker.onPermissionRequested('s1', 'req1');
    tracker.onHookEvent({ sessionId: 's1', hook: 'Stop', timestamp: '2026-04-22T12:01:00Z' });
    expect(tracker.get('s1')?.state).toBe('awaiting-user');
  });

  it('clears to idle when unread drops to zero after Stop', () => {
    tracker.onShimConnected('s1');
    tracker.onUnreadChanged('s1', 1);
    tracker.onHookEvent({ sessionId: 's1', hook: 'UserPromptSubmit', timestamp: '2026-04-22T12:00:00Z' });
    tracker.onHookEvent({ sessionId: 's1', hook: 'Stop', timestamp: '2026-04-22T12:01:00Z' });
    expect(tracker.get('s1')?.state).toBe('awaiting-user');
    tracker.onUnreadChanged('s1', 0);
    expect(tracker.get('s1')?.state).toBe('idle');
  });

  it('stays working if permission requested mid-task and resolved before Stop', () => {
    tracker.onShimConnected('s1');
    tracker.onHookEvent({ sessionId: 's1', hook: 'UserPromptSubmit', timestamp: '2026-04-22T12:00:00Z' });
    tracker.onPermissionRequested('s1', 'req1');
    expect(tracker.get('s1')?.state).toBe('working');
    tracker.onPermissionResolved('s1', 'req1');
    expect(tracker.get('s1')?.state).toBe('working');
  });

  it('goes offline on shim disconnect', () => {
    tracker.onShimConnected('s1');
    tracker.onHookEvent({ sessionId: 's1', hook: 'UserPromptSubmit', timestamp: '2026-04-22T12:00:00Z' });
    tracker.onShimDisconnected('s1');
    expect(tracker.get('s1')?.state).toBe('offline');
  });

  it('does not emit duplicate changes for the same state', () => {
    tracker.onShimConnected('s1');
    tracker.onShimConnected('s1');
    const unknownEmissions = emissions.filter((e) => e.state === 'unknown');
    expect(unknownEmissions).toHaveLength(1);
  });

  it('remembers the last-hook timestamp in the snapshot', () => {
    tracker.onShimConnected('s1');
    tracker.onHookEvent({ sessionId: 's1', hook: 'UserPromptSubmit', timestamp: '2026-04-22T12:00:00Z' });
    const snap = tracker.get('s1')!;
    expect(snap.lastHook).toBe('UserPromptSubmit');
    expect(snap.lastHookAt).toBe('2026-04-22T12:00:00Z');
  });
});
