import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { Icons } from './Icon';
import type { ComposerVariant } from '../types';
import { cn } from '../cn';
import { uploadMedia, type AttachmentRef, type UploadResult } from '../api';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import type { SessionStatus } from '../lib/voiceFsm';
import type { VoiceScope } from '../types';

const ALLOWED_ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/markdown,text/plain';
const MAX_ATTACHMENTS = 5;

interface ComposerProps {
  variant: ComposerVariant;
  sessionId: string;
  onSend: (content: string, attachments: AttachmentRef[]) => Promise<void> | void;
  disabled?: boolean;
  placeholder?: string;
  sessionStatus?: SessionStatus;
  voiceScope?: VoiceScope;
  voicePauseMs?: number;
}

interface QueuedAttachment {
  localId: string;
  status: 'uploading' | 'done' | 'error';
  name: string;
  size: number;
  result?: UploadResult;
  error?: string;
}

export function Composer({
  variant,
  sessionId,
  onSend,
  disabled,
  placeholder,
  sessionStatus = 'unknown',
  voiceScope = 'always',
  voicePauseMs = 1500,
}: ComposerProps): JSX.Element {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [queue, setQueue] = useState<QueuedAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // submitRef breaks circular ref between submit() and the hook's onAutoSubmit callback.
  const submitRef = useRef<() => Promise<void>>(async () => {});

  const speech = useSpeechRecognition({
    enabled: speaking,
    sessionStatus,
    scope: voiceScope,
    pauseMs: voicePauseMs,
    onAutoSubmit: () => {
      void submitRef.current();
    },
    onTranscriptChange: (next) => setText(next),
  });

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [text, speech.interim]);

  const uploading = queue.some((q) => q.status === 'uploading');
  const successful = queue.filter((q) => q.status === 'done' && q.result);
  const canAttach = queue.length < MAX_ATTACHMENTS && !disabled;
  const canSend =
    (text.trim().length > 0 || successful.length > 0) && !sending && !uploading && !disabled;

  const onPickFiles = async (files: FileList | null): Promise<void> => {
    if (!files) return;
    const slots = MAX_ATTACHMENTS - queue.length;
    const picked = Array.from(files).slice(0, slots);
    for (const file of picked) {
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setQueue((q) => [...q, { localId, status: 'uploading', name: file.name, size: file.size }]);
      try {
        const result = await uploadMedia(sessionId, file);
        setQueue((q) =>
          q.map((x) => (x.localId === localId ? { ...x, status: 'done', result } : x)),
        );
      } catch (err) {
        setQueue((q) =>
          q.map((x) =>
            x.localId === localId ? { ...x, status: 'error', error: (err as Error).message } : x,
          ),
        );
      }
    }
  };

  const removeQueued = (localId: string): void => {
    setQueue((q) => q.filter((x) => x.localId !== localId));
  };

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    const refs: AttachmentRef[] = successful.map((q) => ({
      path: q.result!.path,
      mime: q.result!.mime,
      name: q.result!.name,
      kind: q.result!.kind,
      size: q.result!.size,
      sha256: q.result!.sha256,
    }));
    const content = text.trim();
    setSending(true);
    try {
      await onSend(content, refs);
      setText('');
      setQueue([]);
    } finally {
      setSending(false);
    }
  };
  submitRef.current = submit;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape' && speaking) {
      setSpeaking(false);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const onTextChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    if (!speaking) setText(e.target.value);
  };

  const toggleSpeaking = (): void => {
    if (!speech.supported) return;
    if (!speaking) {
      // Seed FSM with whatever the user already typed so spoken text appends to it.
      speech.seedBuffer(text);
    }
    setSpeaking((v) => !v);
  };

  const displayedText =
    speaking && speech.interim
      ? `${text}${text && !text.endsWith(' ') ? ' ' : ''}${speech.interim}`
      : text;
  const placeholderText = speaking
    ? speech.error
      ? 'voice input error — tap mic to retry'
      : 'listening — speak your message…'
    : (placeholder ?? 'Message the session…');
  const isMinimal = variant === 'minimal';
  const isSegmented = variant === 'segmented';

  const voiceMessage: string | null = (() => {
    if (speaking && !speech.supported) return 'voice input not supported in this browser';
    if (speech.error === 'not-allowed')
      return 'microphone permission denied — check browser site settings';
    if (speech.error === 'audio-capture') return 'no microphone available';
    if (speech.error === 'network') return 'voice input failed (network)';
    if (speech.error === 'no-speech') return 'voice input paused — no speech detected for 60s';
    if (speech.error === 'unknown') return 'voice input error';
    return null;
  })();

  const voiceRow =
    voiceMessage !== null ? (
      <div className="px-3 pb-1 font-mono text-[10.5px] text-fg-4">{voiceMessage}</div>
    ) : null;

  const chips =
    queue.length > 0 ? (
      <div className="flex flex-wrap gap-1.5 px-3 pt-2">
        {queue.map((q) => (
          <span
            key={q.localId}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]',
              q.status === 'error' ? 'border-red-500 text-red-500' : 'border-line text-fg-2',
            )}
            title={q.error}
          >
            <Icons.paperclip size={11} />
            <span className="max-w-[160px] truncate">{q.name}</span>
            <span className="text-fg-4">{formatBytes(q.size)}</span>
            {q.status === 'uploading' ? <span className="text-fg-4">…</span> : null}
            <button
              type="button"
              onClick={() => removeQueued(q.localId)}
              className="text-fg-3 hover:text-fg"
              aria-label={`Remove ${q.name}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
    ) : null;

  const hiddenInput = (
    <input
      ref={fileInputRef}
      type="file"
      multiple
      accept={ALLOWED_ACCEPT}
      style={{ display: 'none' }}
      onChange={(e) => {
        void onPickFiles(e.target.files);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }}
    />
  );

  if (isSegmented) {
    return (
      <div
        className={cn('flex flex-col gap-2 border-t border-line p-3')}
        style={{ background: 'color-mix(in oklab, var(--bg) 60%, var(--bg-1))' }}
      >
        {chips}
        {hiddenInput}
        <div
          className={cn(
            'flex flex-col gap-0 rounded-[10px] border border-line bg-bg-2 transition',
            'focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]',
            speaking && 'composer-speaking',
          )}
        >
          <textarea
            ref={taRef}
            rows={1}
            value={displayedText}
            onChange={onTextChange}
            onKeyDown={onKeyDown}
            placeholder={placeholderText}
            readOnly={speaking}
            className="min-h-[22px] max-h-[160px] resize-none border-0 bg-transparent px-3.5 py-3 text-[13.5px] leading-[1.5] text-fg outline-none placeholder:text-fg-4"
          />
          <div className="flex items-center gap-1 border-t border-line px-2 py-1.5 font-mono text-[11px]">
            <ToolButton
              title="Attach file"
              disabled={!canAttach}
              onClick={() => fileInputRef.current?.click()}
            >
              <Icons.paperclip size={14} />
              attach
            </ToolButton>
            <ToolButton
              title={speech.supported ? 'Speak' : 'Voice input not supported in this browser'}
              active={speaking}
              disabled={!speech.supported}
              onClick={toggleSpeaking}
            >
              <Icons.mic size={14} />
              {speaking ? 'listening…' : 'speak'}
            </ToolButton>
            <div className="flex-1" />
            <SendButton
              canSend={canSend}
              sending={sending}
              countingDown={speech.countingDown}
              onClick={() => void submit()}
              onCancelCountdown={speech.cancelCountdown}
            />
          </div>
        </div>
        {voiceRow}
      </div>
    );
  }

  if (isMinimal) {
    return (
      <div className={cn('flex flex-col gap-2 border-t border-line px-3 py-2')}>
        {chips}
        {hiddenInput}
        <div className="flex items-end gap-2">
          <span className="pb-1.5 font-mono text-[13px] text-fg-4">$</span>
          <IBtn
            title="Attach file"
            disabled={!canAttach}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icons.paperclip size={14} />
          </IBtn>
          <textarea
            ref={taRef}
            rows={1}
            value={displayedText}
            onChange={onTextChange}
            onKeyDown={onKeyDown}
            placeholder={placeholderText}
            readOnly={speaking}
            className="min-h-[22px] max-h-[160px] flex-1 resize-none border-0 bg-transparent px-1 py-1.5 font-mono text-[12.5px] text-fg outline-none placeholder:text-fg-4"
          />
          <SendButton
            canSend={canSend}
            sending={sending}
            countingDown={speech.countingDown}
            onClick={() => void submit()}
            onCancelCountdown={speech.cancelCountdown}
          />
        </div>
        {voiceRow}
      </div>
    );
  }

  // rail (default)
  return (
    <div
      className="flex flex-col gap-2 border-t border-line p-3"
      style={{ background: 'color-mix(in oklab, var(--bg) 60%, var(--bg-1))' }}
    >
      {chips}
      {hiddenInput}
      <div
        className={cn(
          'flex items-end gap-2 rounded-[10px] border border-line bg-bg-2 px-2.5 py-2 transition',
          'focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]',
          speaking && 'composer-speaking',
        )}
      >
        <div className="flex items-center gap-0.5">
          <IBtn
            title="Attach file"
            disabled={!canAttach}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icons.paperclip size={14} />
          </IBtn>
          <IBtn
            title={
              speech.supported ? 'Speak (Esc to stop)' : 'Voice input not supported in this browser'
            }
            active={speaking}
            disabled={!speech.supported}
            onClick={toggleSpeaking}
          >
            <Icons.mic size={14} />
          </IBtn>
        </div>
        <textarea
          ref={taRef}
          rows={1}
          value={displayedText}
          onChange={onTextChange}
          onKeyDown={onKeyDown}
          placeholder={placeholderText}
          readOnly={speaking}
          className="min-h-[22px] max-h-[160px] flex-1 resize-none border-0 bg-transparent px-1 py-1.5 text-[13.5px] leading-[1.5] text-fg outline-none placeholder:text-fg-4"
        />
        <SendButton
          canSend={canSend}
          sending={sending}
          countingDown={speech.countingDown}
          onClick={() => void submit()}
          onCancelCountdown={speech.cancelCountdown}
        />
      </div>
      <div className="flex justify-between px-1 font-mono text-[10.5px] text-fg-4">
        <span>
          <Kbd>⏎</Kbd> send · <Kbd>⇧⏎</Kbd> newline
        </span>
        <span>end-to-end via VPS</span>
      </div>
      {voiceRow}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function Kbd({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <kbd className="rounded-[3px] border border-line bg-bg-1 px-1 py-px text-[10px] text-fg-3">
      {children}
    </kbd>
  );
}

function IBtn({
  title,
  disabled,
  active,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid size-[30px] place-items-center rounded-md text-fg-3 transition-colors',
        'hover:bg-bg-3 hover:text-fg',
        active && 'text-accent bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]',
        disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent hover:text-fg-3',
      )}
    >
      {children}
    </button>
  );
}

function ToolButton({
  title,
  disabled,
  active,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-fg-3 transition-colors',
        'hover:bg-bg-3 hover:text-fg',
        active && 'text-accent bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]',
        disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent hover:text-fg-3',
      )}
    >
      {children}
    </button>
  );
}

function SendButton({
  canSend,
  sending,
  countingDown,
  onClick,
  onCancelCountdown,
}: {
  canSend: boolean;
  sending: boolean;
  countingDown?: boolean;
  onClick: () => void;
  onCancelCountdown?: () => void;
}): JSX.Element {
  if (countingDown) {
    return (
      <button
        type="button"
        onClick={onCancelCountdown}
        title="Cancel — keep talking"
        aria-label="Cancel countdown"
        className="voice-countdown inline-flex h-[30px] items-center gap-1.5 rounded-md bg-accent px-3 font-mono text-xs font-semibold text-[color:#0b0c0f] hover:brightness-110"
      >
        cancel
        <Icons.close size={12} stroke="#0b0c0f" />
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={!canSend}
      onClick={onClick}
      className="inline-flex h-[30px] items-center gap-1.5 rounded-md bg-accent px-3 font-mono text-xs font-semibold text-[color:#0b0c0f] transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {sending ? 'sending…' : 'send'}
      <Icons.send size={12} stroke="#0b0c0f" />
    </button>
  );
}
