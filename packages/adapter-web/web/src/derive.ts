import type { SessionSummary } from './api';
import type { Status } from './types';

export function sessionStatus(s: SessionSummary): Status {
  return s.activity_state;
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
