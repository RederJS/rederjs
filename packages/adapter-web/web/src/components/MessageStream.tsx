import { useCallback, useLayoutEffect, useRef } from 'react';
import type { TranscriptMessage } from '../api';
import type { BubbleVariant, PendingPermission, Status } from '../types';
import { MessageBubble, parseButtons } from './MessageBubble';
import { PermissionCard } from './PermissionCard';
import { TypingIndicator } from './TypingIndicator';
import { dayKey, dayLabel } from '../format';
import { cn } from '../cn';

// "Near bottom" threshold in pixels — below this distance from the bottom we
// treat the user as stuck to the latest message and auto-scroll on update.
const STICKY_THRESHOLD_PX = 64;

interface MessageStreamProps {
  messages: TranscriptMessage[];
  status: Status;
  bubbleVariant: BubbleVariant;
  permissions: PendingPermission[];
  onPermissionDecision: (requestId: string, behavior: 'allow' | 'deny') => void;
  decisionBusyIds: Set<string>;
  onQuickReply?: (msg: TranscriptMessage, value: string, label: string) => void;
  answeredByMsgId: Map<string, string>;
}

export function MessageStream({
  messages,
  status,
  bubbleVariant,
  permissions,
  onPermissionDecision,
  decisionBusyIds,
  onQuickReply,
  answeredByMsgId,
}: MessageStreamProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the user is currently pinned to the bottom of the transcript.
  // Stored in a ref so the auto-scroll effect can read it without re-running
  // every time the user scrolls.
  const stuckToBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stuckToBottomRef.current = distance <= STICKY_THRESHOLD_PX;
  }, []);

  const showTypingIndicator = status === 'working';

  useLayoutEffect(() => {
    if (!stuckToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, permissions.length, showTypingIndicator]);

  const latestButtonedId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.direction === 'outbound' && parseButtons(m) && !answeredByMsgId.has(m.messageId)) {
        return m.messageId;
      }
    }
    return null;
  })();

  // Insert day separators between messages
  const items: Array<
    { kind: 'day'; key: string; label: string } | { kind: 'msg'; msg: TranscriptMessage }
  > = [];
  let lastDay = '';
  for (const m of messages) {
    const dk = dayKey(m.timestamp);
    if (dk !== lastDay) {
      items.push({ kind: 'day', key: `day-${dk}`, label: dayLabel(m.timestamp) });
      lastDay = dk;
    }
    items.push({ kind: 'msg', msg: m });
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      data-bubble={bubbleVariant}
      className={cn('stream-bg flex flex-col gap-3.5 overflow-y-auto px-4 pt-5 pb-2.5 min-h-0')}
    >
      {items.map((it) =>
        it.kind === 'day' ? (
          <div
            key={it.key}
            className="mx-0 my-0.5 flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[0.1em] text-fg-4 before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line"
          >
            {it.label}
          </div>
        ) : (
          <MessageBubble
            key={it.msg.messageId}
            msg={it.msg}
            bubbleVariant={bubbleVariant}
            buttons={parseButtons(it.msg) ?? undefined}
            isLatestButtoned={it.msg.messageId === latestButtonedId}
            answeredLabel={answeredByMsgId.get(it.msg.messageId)}
            onQuickReply={
              onQuickReply ? (val, label) => onQuickReply(it.msg, val, label) : undefined
            }
            fileCount={it.msg.files.length}
          />
        ),
      )}

      {permissions.map((p) => (
        <PermissionCard
          key={p.requestId}
          permission={p}
          pending={decisionBusyIds.has(p.requestId)}
          onDecide={(b) => onPermissionDecision(p.requestId, b)}
        />
      ))}

      {showTypingIndicator && <TypingIndicator bubbleVariant={bubbleVariant} />}
    </div>
  );
}
