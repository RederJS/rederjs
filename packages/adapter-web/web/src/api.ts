export interface SessionSummary {
  session_id: string;
  display_name: string;
  workspace_dir: string | null;
  auto_start: boolean;
  state: string;
  last_seen_at: string | null;
  shim_connected: boolean;
  tmux_running: boolean;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  unread: number;
}

export interface TranscriptMessage {
  messageId: string;
  direction: 'inbound' | 'outbound';
  sessionId: string;
  adapter: string;
  party: string;
  content: string;
  meta: Record<string, string>;
  files: string[];
  timestamp: string;
  state: string;
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text || res.statusText}`);
  }
  return res.json();
}

export async function listSessions(): Promise<SessionSummary[]> {
  const r = (await jsonOrThrow(await fetch('/api/sessions'))) as { sessions: SessionSummary[] };
  return r.sessions;
}

export async function getSession(sessionId: string): Promise<SessionSummary> {
  return (await jsonOrThrow(await fetch(`/api/sessions/${sessionId}`))) as SessionSummary;
}

export async function listMessages(
  sessionId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<TranscriptMessage[]> {
  const params = new URLSearchParams();
  if (opts.before) params.set('before', opts.before);
  if (opts.limit) params.set('limit', String(opts.limit));
  const query = params.toString();
  const url = `/api/sessions/${sessionId}/messages${query ? `?${query}` : ''}`;
  const r = (await jsonOrThrow(await fetch(url))) as { messages: TranscriptMessage[] };
  return r.messages;
}

export async function sendMessage(sessionId: string, content: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

export async function startSession(sessionId: string): Promise<{ started: boolean; reason?: string; error?: string }> {
  const res = await fetch(`/api/sessions/${sessionId}/start`, { method: 'POST' });
  return (await jsonOrThrow(res)) as { started: boolean; reason?: string; error?: string };
}

export async function resolvePermission(
  sessionId: string,
  requestId: string,
  behavior: 'allow' | 'deny',
): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/permissions/${requestId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ behavior }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}
