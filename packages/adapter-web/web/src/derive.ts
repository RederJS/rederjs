import type { SessionSummary } from './api';
import type { Status } from './types';

const BUSY_WINDOW_MS = 2 * 60_000;

export function deriveStatus(s: SessionSummary): Status {
  if (!s.tmux_running) return 'offline';
  if (s.unread > 0) return 'waiting';
  const last = s.last_outbound_at ? Date.parse(s.last_outbound_at) : 0;
  if (last && Date.now() - last < BUSY_WINDOW_MS) return 'busy';
  return 'idle';
}

export function initials(name: string): string {
  const clean = name.trim();
  if (!clean) return '??';
  const parts = clean.split(/[\s_\-.]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function avatarColor(sessionId: string): string {
  const hue = hash(sessionId) % 360;
  return `hsl(${hue}deg 55% 65%)`;
}

export function shortId(sessionId: string): string {
  if (sessionId.length <= 8) return sessionId;
  return sessionId.slice(0, 8);
}
