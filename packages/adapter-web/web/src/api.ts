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
  activity_state: 'working' | 'awaiting-user' | 'idle' | 'unknown' | 'offline';
  activity_since: string | null;
  last_hook: string | null;
  last_hook_at: string | null;
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

export interface AttachmentRef {
  path: string;
  mime: string;
  name: string;
  kind: 'image' | 'document';
  size: number;
  sha256: string;
}

export interface UploadResult {
  sha256: string;
  size: number;
  mime: string;
  name: string;
  path: string;
  kind: 'image' | 'document';
}

export async function uploadMedia(sessionId: string, file: File): Promise<UploadResult> {
  const fd = new FormData();
  fd.append('file', file, file.name);
  const res = await fetch(`/api/sessions/${sessionId}/media`, {
    method: 'POST',
    body: fd,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upload failed (${res.status}): ${text}`);
  }
  return (await res.json()) as UploadResult;
}

export function mediaUrl(sessionId: string, sha256: string): string {
  return `/api/sessions/${sessionId}/media/${sha256}`;
}

export function decodeAttachmentsMeta(raw: string | undefined): AttachmentRef[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAttachmentRef);
  } catch {
    return [];
  }
}

function isAttachmentRef(v: unknown): v is AttachmentRef {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['path'] === 'string' &&
    typeof r['mime'] === 'string' &&
    typeof r['name'] === 'string' &&
    (r['kind'] === 'image' || r['kind'] === 'document') &&
    typeof r['size'] === 'number' &&
    typeof r['sha256'] === 'string'
  );
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

export async function sendMessage(
  sessionId: string,
  content: string,
  attachments: AttachmentRef[] = [],
): Promise<void> {
  const body: { content: string; files?: string[]; meta?: Record<string, string> } = { content };
  if (attachments.length > 0) {
    body.files = attachments.map((a) => a.path);
    body.meta = { attachments: JSON.stringify(attachments) };
  }
  const res = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

export async function startSession(
  sessionId: string,
): Promise<{ started: boolean; reason?: string; error?: string }> {
  const res = await fetch(`/api/sessions/${sessionId}/start`, { method: 'POST' });
  return (await jsonOrThrow(res)) as { started: boolean; reason?: string; error?: string };
}

export async function repairSession(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/repair`, { method: 'POST' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

export interface SystemStats {
  cpu_percent: number;
  cpu_per_core: number[];
  mem_used_bytes: number;
  mem_total_bytes: number;
  mem_percent: number;
  uptime_seconds: number;
}

export async function getSystemStats(): Promise<SystemStats> {
  return (await jsonOrThrow(await fetch('/api/system/stats'))) as SystemStats;
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
