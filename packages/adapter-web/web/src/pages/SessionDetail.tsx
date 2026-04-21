import { useEffect, useRef, useState } from 'react';
import {
  getSession,
  listMessages,
  resolvePermission,
  sendMessage,
  type SessionSummary,
  type TranscriptMessage,
} from '../api';
import { useEventStream } from '../sse';
import { navigate } from '../router';

interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolName: string;
  description: string;
  inputPreview: string;
  expiresAt: string;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function MessageBubble({ msg }: { msg: TranscriptMessage }): JSX.Element {
  const mine = msg.direction === 'inbound' && msg.adapter === 'web';
  const isInbound = msg.direction === 'inbound';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
          mine
            ? 'bg-accent text-canvas'
            : isInbound
              ? 'bg-panel2 text-slate-200'
              : 'bg-panel text-slate-100 ring-1 ring-border'
        }`}
      >
        {!mine && (
          <div className="mb-1 text-[10px] uppercase tracking-wide opacity-60">
            {isInbound ? `${msg.adapter}:${msg.party}` : 'claude'}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words">{msg.content || '(no content)'}</div>
        {msg.files.length > 0 && (
          <div className="mt-2 text-xs opacity-70">
            {msg.files.length} attachment{msg.files.length === 1 ? '' : 's'}
          </div>
        )}
        <div
          className={`mt-1 text-[10px] ${mine ? 'text-canvas/70' : 'text-muted'}`}
        >
          {fmtTime(msg.timestamp)}
        </div>
      </div>
    </div>
  );
}

export function SessionDetail({ sessionId }: { sessionId: string }): JSX.Element {
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [pending, setPending] = useState<PendingPermission[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  const refresh = async (): Promise<void> => {
    try {
      const [s, m] = await Promise.all([getSession(sessionId), listMessages(sessionId)]);
      setSession(s);
      // Display oldest → newest.
      setMessages([...m].reverse());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    void refresh().then(() => scrollToBottom());
  }, [sessionId]);

  useEventStream(`/api/sessions/${sessionId}/stream`, (name, data) => {
    if (name === 'inbound' || name === 'outbound.persisted' || name === 'outbound') {
      void refresh().then(() => scrollToBottom());
      return;
    }
    if (name === 'permission.requested') {
      const p = data as PendingPermission;
      setPending((prev) => (prev.some((x) => x.requestId === p.requestId) ? prev : [...prev, p]));
      return;
    }
    if (name === 'permission.resolved' || name === 'permission.cancelled') {
      const p = data as { requestId: string };
      setPending((prev) => prev.filter((x) => x.requestId !== p.requestId));
      return;
    }
    if (name === 'session.state_changed') {
      void refresh();
    }
  });

  const handleSend = async (): Promise<void> => {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await sendMessage(sessionId, content);
      setInput('');
      await refresh();
      scrollToBottom();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const handleDecision = async (
    reqId: string,
    behavior: 'allow' | 'deny',
  ): Promise<void> => {
    try {
      await resolvePermission(sessionId, reqId, behavior);
      setPending((prev) => prev.filter((x) => x.requestId !== reqId));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-panel/70 px-5 py-3 backdrop-blur">
        <button
          onClick={() => navigate('/')}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:border-accent hover:text-accent"
        >
          ← Sessions
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-medium text-slate-100">
            {session?.display_name ?? sessionId}
          </h1>
          <div className="truncate font-mono text-xs text-muted">
            {session?.workspace_dir ?? sessionId}
          </div>
        </div>
        {session && (
          <div className="flex items-center gap-3 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 ${session.shim_connected ? 'text-ok' : 'text-muted'}`}
            >
              <span
                className={`h-2 w-2 rounded-full ${session.shim_connected ? 'bg-ok' : 'bg-muted'}`}
              />
              shim
            </span>
            <span
              className={`inline-flex items-center gap-1.5 ${session.tmux_running ? 'text-ok' : 'text-muted'}`}
            >
              <span
                className={`h-2 w-2 rounded-full ${session.tmux_running ? 'bg-ok' : 'bg-muted'}`}
              />
              tmux
            </span>
          </div>
        )}
      </header>

      {pending.length > 0 && (
        <div className="space-y-2 border-b border-warn/30 bg-warn/5 px-5 py-3">
          {pending.map((p) => (
            <div
              key={p.requestId}
              className="flex items-center justify-between gap-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-warn">
                  Permission requested: {p.toolName}
                </div>
                <div className="truncate text-xs text-muted">{p.description}</div>
                <div className="mt-1 overflow-hidden truncate font-mono text-[11px] text-muted">
                  {p.inputPreview}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => void handleDecision(p.requestId, 'deny')}
                  className="rounded-md border border-err/40 px-3 py-1 text-xs text-err hover:bg-err/10"
                >
                  Deny
                </button>
                <button
                  onClick={() => void handleDecision(p.requestId, 'allow')}
                  className="rounded-md bg-ok px-3 py-1 text-xs font-medium text-canvas hover:brightness-110"
                >
                  Allow
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {err && (
        <div className="border-b border-err/30 bg-err/10 px-5 py-2 text-sm text-err">{err}</div>
      )}

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {messages.length === 0 ? (
          <div className="grid h-full place-items-center text-sm text-muted">
            No messages yet. Send one below.
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.messageId} msg={m} />)
        )}
      </div>

      <form
        className="border-t border-border bg-panel/60 px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder="Type an instruction…  (Enter to send, Shift+Enter for newline)"
            rows={1}
            className="max-h-36 flex-1 resize-none rounded-md border border-border bg-canvas px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent"
          />
          <button
            type="submit"
            disabled={sending || input.trim().length === 0}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-canvas disabled:opacity-50 hover:bg-accent2"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
