import type { TranscriptMessage } from '../api';
import type { BubbleVariant, QuickReply } from '../types';
import { decodeAttachmentsMeta, mediaUrl, type AttachmentRef } from '../api';
import { formatHHMM } from '../format';
import { Markdown } from './Markdown';
import { Icons } from './Icon';
import { cn } from '../cn';

interface MessageBubbleProps {
  msg: TranscriptMessage;
  bubbleVariant: BubbleVariant;
  isLatestButtoned?: boolean;
  buttons?: QuickReply[];
  answeredLabel?: string;
  onQuickReply?: (value: string, label: string) => void;
  fileCount?: number;
}

export function parseButtons(msg: TranscriptMessage): QuickReply[] | null {
  const raw = msg.meta?.buttons;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out: QuickReply[] = [];
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        const label = (item as { label?: unknown }).label;
        const value = (item as { value?: unknown }).value;
        const kind = (item as { kind?: unknown }).kind;
        if (typeof label === 'string' && typeof value === 'string') {
          out.push({
            label,
            value,
            kind: kind === 'primary' || kind === 'danger' ? kind : undefined,
          });
        }
      }
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

export function MessageBubble({
  msg,
  bubbleVariant,
  isLatestButtoned,
  buttons,
  answeredLabel,
  onQuickReply,
  fileCount = 0,
}: MessageBubbleProps): JSX.Element {
  const mine = msg.direction === 'inbound' && (msg.adapter === 'web' || msg.adapter === 'local');
  const whoLabel =
    msg.direction === 'inbound' && msg.adapter === 'local'
      ? 'tmux'
      : mine
        ? 'you'
        : msg.direction === 'outbound'
          ? 'claude'
          : `${msg.adapter}:${msg.party}`;

  const bubbleStyles =
    bubbleVariant === 'terminal'
      ? cn(
          'border-0 border-l-2 bg-transparent pl-3 py-0 rounded-none font-mono text-[12.5px]',
          mine ? 'border-accent' : 'border-line',
        )
      : bubbleVariant === 'minimal'
        ? cn('border-0 bg-transparent px-0 py-0 rounded-none', mine && 'text-accent')
        : mine
          ? 'rounded-[10px] rounded-tr-[3px] border bg-bubble-me text-fg px-3 py-2.5'
          : 'rounded-[10px] rounded-tl-[3px] border border-line bg-bubble-them text-fg px-3 py-2.5';

  const meBorderExtra =
    bubbleVariant === 'classic' && mine
      ? { borderColor: 'color-mix(in oklab, var(--accent) 25%, var(--line))' }
      : undefined;

  const attachments = decodeAttachmentsMeta(msg.meta?.attachments);
  const showLegacyCount = attachments.length === 0 && fileCount > 0;

  return (
    <div
      className={cn(
        'flex max-w-[88%] flex-col gap-1',
        mine ? 'self-end items-end' : 'self-start items-start',
      )}
    >
      <div className="flex items-center gap-2 font-mono text-[10.5px] text-fg-4">
        <b className="font-medium text-fg-2">{whoLabel}</b>
        <span>{formatHHMM(msg.timestamp)}</span>
      </div>
      <div
        className={cn('max-w-full break-words text-[13.5px] leading-[1.55]', bubbleStyles)}
        style={meBorderExtra}
      >
        {msg.content ? (
          <Markdown src={msg.content} />
        ) : (
          <span className="text-fg-4">(no content)</span>
        )}
        {attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {attachments.map((a) =>
              a.kind === 'image' ? (
                <ImageAttachment key={a.sha256} sessionId={msg.sessionId} ref_={a} />
              ) : (
                <DocAttachment key={a.sha256} sessionId={msg.sessionId} ref_={a} />
              ),
            )}
          </div>
        )}
        {showLegacyCount && (
          <div className="mt-1.5 text-[11px] text-fg-3">
            {fileCount} attachment{fileCount === 1 ? '' : 's'}
          </div>
        )}
      </div>

      {answeredLabel ? (
        <div className="mt-1.5 flex items-center gap-2 border-l-2 border-line-2 py-0.5 pl-2.5 font-mono text-[11px] text-fg-4">
          ↳ replied · <b className="font-medium text-fg-2">{answeredLabel}</b>
        </div>
      ) : buttons && buttons.length > 0 ? (
        isLatestButtoned ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {buttons.map((b) => (
              <button
                key={b.label}
                type="button"
                className={cn(
                  'qbtn',
                  b.kind === 'primary' && 'primary',
                  b.kind === 'danger' && 'danger',
                )}
                onClick={() => onQuickReply?.(b.value, b.label)}
              >
                {b.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-1.5 font-mono text-[11px] text-fg-4">superseded</div>
        )
      ) : null}
    </div>
  );
}

function ImageAttachment({
  sessionId,
  ref_,
}: {
  sessionId: string;
  ref_: AttachmentRef;
}): JSX.Element {
  const url = mediaUrl(sessionId, ref_.sha256);
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block max-w-[300px]">
      <img
        src={url}
        alt={ref_.name}
        loading="lazy"
        className="max-w-[300px] rounded-md border border-line"
      />
    </a>
  );
}

function DocAttachment({
  sessionId,
  ref_,
}: {
  sessionId: string;
  ref_: AttachmentRef;
}): JSX.Element {
  const url = mediaUrl(sessionId, ref_.sha256);
  const Icon =
    ref_.mime === 'application/pdf'
      ? Icons.filePdf
      : ref_.mime === 'text/markdown'
        ? Icons.fileMd
        : Icons.fileTxt;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 rounded-md border border-line bg-bg-2 px-2.5 py-1.5 text-[12px] text-fg hover:bg-bg-3"
    >
      <Icon size={14} />
      <span className="max-w-[200px] truncate">{ref_.name}</span>
      <span className="text-fg-4">{formatBytes(ref_.size)}</span>
    </a>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
