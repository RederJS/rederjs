import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listMessages,
  resolvePermission,
  sendMessage,
  type SessionSummary,
  type TranscriptMessage,
} from '../api';
import { sessionStatus } from '../derive';
import { useEventStream } from '../sse';
import type { BubbleVariant, ComposerVariant, PendingPermission, StatusVariant } from '../types';
import { Composer } from './Composer';
import { MessageStream } from './MessageStream';
import { PanelHeader } from './PanelHeader';
import { parseButtons } from './MessageBubble';

interface PanelProps {
  session: SessionSummary;
  sessions: SessionSummary[];
  statusVariant: StatusVariant;
  bubbleVariant: BubbleVariant;
  composerVariant: ComposerVariant;
  onClose: () => void;
  onSwitchSession: (sessionId: string) => void;
}

export function Panel({
  session,
  sessions,
  statusVariant,
  bubbleVariant,
  composerVariant,
  onClose,
  onSwitchSession,
}: PanelProps): JSX.Element {
  const sessionId = session.session_id;
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [permissions, setPermissions] = useState<PendingPermission[]>([]);
  const [decisionBusyIds, setDecisionBusyIds] = useState<Set<string>>(new Set());
  const [answeredByMsgId, setAnsweredByMsgId] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const m = await listMessages(sessionId);
      setMessages([...m].reverse());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sessionId]);

  useEffect(() => {
    setMessages([]);
    setPermissions([]);
    setAnsweredByMsgId(new Map());
    setError(null);
    void refresh();
  }, [sessionId, refresh]);

  useEventStream(`/api/sessions/${sessionId}/stream`, (name, data) => {
    if (name === 'inbound' || name === 'outbound' || name === 'outbound.persisted') {
      void refresh();
      return;
    }
    if (name === 'permission.requested') {
      const p = data as PendingPermission;
      setPermissions((prev) =>
        prev.some((x) => x.requestId === p.requestId) ? prev : [...prev, p],
      );
      return;
    }
    if (name === 'permission.resolved' || name === 'permission.cancelled') {
      const p = data as { requestId: string };
      setPermissions((prev) => prev.filter((x) => x.requestId !== p.requestId));
      return;
    }
  });

  const onSend = useCallback(
    async (content: string): Promise<void> => {
      await sendMessage(sessionId, content);
      await refresh();
    },
    [sessionId, refresh],
  );

  const handlePermission = useCallback(
    async (requestId: string, behavior: 'allow' | 'deny'): Promise<void> => {
      setDecisionBusyIds((s) => new Set(s).add(requestId));
      try {
        await resolvePermission(sessionId, requestId, behavior);
        setPermissions((prev) => prev.filter((x) => x.requestId !== requestId));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setDecisionBusyIds((s) => {
          const next = new Set(s);
          next.delete(requestId);
          return next;
        });
      }
    },
    [sessionId],
  );

  const status = useMemo(() => sessionStatus(session), [session]);

  const onQuickReply = useCallback(
    async (msg: TranscriptMessage, value: string, label: string): Promise<void> => {
      setAnsweredByMsgId((prev) => {
        const next = new Map(prev);
        next.set(msg.messageId, label);
        return next;
      });
      try {
        await sendMessage(sessionId, value);
        await refresh();
      } catch (e) {
        setError((e as Error).message);
        setAnsweredByMsgId((prev) => {
          const next = new Map(prev);
          next.delete(msg.messageId);
          return next;
        });
      }
    },
    [sessionId, refresh],
  );

  // Drop quick-reply buttons we've answered from showing up again after refresh
  useEffect(() => {
    if (answeredByMsgId.size === 0) return;
    const visibleIds = new Set(messages.map((m) => m.messageId));
    // Remove stale entries (messages no longer in stream)
    setAnsweredByMsgId((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of prev.keys()) {
        if (!visibleIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [messages, answeredByMsgId.size]);

  // Ensure outbound messages that *already contain* `meta.buttons` we've answered stay marked
  useEffect(() => {
    if (messages.length === 0) return;
    for (const m of messages) {
      if (m.direction === 'outbound' && parseButtons(m)) {
        // nothing to do; answered state is local
      }
    }
  }, [messages]);

  return (
    <div className="grid min-h-0 min-w-0 grid-rows-[auto_1fr_auto] overflow-hidden border-l border-line bg-bg">
      <PanelHeader
        session={session}
        sessions={sessions}
        statusVariant={statusVariant}
        onClose={onClose}
        onSwitchSession={onSwitchSession}
      />
      {error && (
        <div
          className="border-b px-4 py-2 text-xs"
          style={{
            borderColor: 'color-mix(in oklab, #ff6b6b 40%, var(--line))',
            background: 'color-mix(in oklab, #ff6b6b 10%, var(--bg))',
            color: '#ff8a8a',
          }}
        >
          {error}
        </div>
      )}
      <MessageStream
        messages={messages}
        status={status}
        bubbleVariant={bubbleVariant}
        permissions={permissions}
        onPermissionDecision={handlePermission}
        decisionBusyIds={decisionBusyIds}
        onQuickReply={onQuickReply}
        answeredByMsgId={answeredByMsgId}
      />
      <Composer variant={composerVariant} onSend={onSend} />
    </div>
  );
}
