const SESSION_ID_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;

export function sanitizeSessionId(input: string): string {
  let s = input.toLowerCase();
  s = s.replace(/[^a-z0-9_-]+/g, '-');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^[-_]+|[-_]+$/g, '');
  if (s.length > 63) s = s.slice(0, 63);
  if (s.length > 0 && !/^[a-z0-9]/.test(s)) s = 's' + s;
  if (s.length > 63) s = s.slice(0, 63);
  return s;
}

export function validateSessionId(id: string): true | string {
  if (SESSION_ID_RE.test(id)) return true;
  return `session id must match [a-z0-9][a-z0-9_-]{1,62} (got '${id}')`;
}

export function prettifyDisplayName(sessionId: string): string {
  const spaced = sessionId.replace(/[-_]+/g, ' ').trim();
  if (!spaced) return sessionId;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
