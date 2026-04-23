import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { Icons } from './Icon';
import type { ComposerVariant } from '../types';
import { cn } from '../cn';

interface ComposerProps {
  variant: ComposerVariant;
  onSend: (content: string) => Promise<void> | void;
  disabled?: boolean;
  placeholder?: string;
}

export function Composer({ variant, onSend, disabled, placeholder }: ComposerProps): JSX.Element {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize the textarea up to max-height
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [text]);

  const canSend = text.trim().length > 0 && !sending && !disabled;

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    const content = text.trim();
    setSending(true);
    try {
      await onSend(content);
      setText('');
    } finally {
      setSending(false);
    }
  };

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

  const placeholderText = speaking
    ? 'listening — speak your message…'
    : (placeholder ?? 'Message the session…');
  const isMinimal = variant === 'minimal';
  const isSegmented = variant === 'segmented';

  const onTextChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    if (!speaking) setText(e.target.value);
  };

  if (isSegmented) {
    return (
      <div
        className={cn('flex flex-col gap-2 border-t border-line p-3')}
        style={{ background: 'color-mix(in oklab, var(--bg) 60%, var(--bg-1))' }}
      >
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
            value={text}
            onChange={onTextChange}
            onKeyDown={onKeyDown}
            placeholder={placeholderText}
            readOnly={speaking}
            className="min-h-[22px] max-h-[160px] resize-none border-0 bg-transparent px-3.5 py-3 text-[13.5px] leading-[1.5] text-fg outline-none placeholder:text-fg-4"
          />
          <div className="flex items-center gap-1 border-t border-line px-2 py-1.5 font-mono text-[11px]">
            <ToolButton title="Attach file" disabled>
              <Icons.paperclip size={14} />
              attach
            </ToolButton>
            <ToolButton title="Speak" active={speaking} onClick={() => setSpeaking((v) => !v)}>
              <Icons.mic size={14} />
              {speaking ? 'listening…' : 'speak'}
            </ToolButton>
            <div className="flex-1" />
            <SendButton canSend={canSend} sending={sending} onClick={() => void submit()} />
          </div>
        </div>
      </div>
    );
  }

  if (isMinimal) {
    return (
      <div className={cn('flex items-end gap-2 border-t border-line px-3 py-2')}>
        <span className="pb-1.5 font-mono text-[13px] text-fg-4">$</span>
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          onChange={onTextChange}
          onKeyDown={onKeyDown}
          placeholder={placeholderText}
          readOnly={speaking}
          className="min-h-[22px] max-h-[160px] flex-1 resize-none border-0 bg-transparent px-1 py-1.5 font-mono text-[12.5px] text-fg outline-none placeholder:text-fg-4"
        />
        <SendButton canSend={canSend} sending={sending} onClick={() => void submit()} />
      </div>
    );
  }

  // rail (default)
  return (
    <div
      className="flex flex-col gap-2 border-t border-line p-3"
      style={{ background: 'color-mix(in oklab, var(--bg) 60%, var(--bg-1))' }}
    >
      <div
        className={cn(
          'flex items-end gap-2 rounded-[10px] border border-line bg-bg-2 px-2.5 py-2 transition',
          'focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)]',
          speaking && 'composer-speaking',
        )}
      >
        <div className="flex items-center gap-0.5">
          <IBtn title="Attach file" disabled>
            <Icons.paperclip size={14} />
          </IBtn>
          <IBtn
            title="Speak (Esc to stop)"
            active={speaking}
            onClick={() => setSpeaking((v) => !v)}
          >
            <Icons.mic size={14} />
          </IBtn>
        </div>
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          onChange={onTextChange}
          onKeyDown={onKeyDown}
          placeholder={placeholderText}
          readOnly={speaking}
          className="min-h-[22px] max-h-[160px] flex-1 resize-none border-0 bg-transparent px-1 py-1.5 text-[13.5px] leading-[1.5] text-fg outline-none placeholder:text-fg-4"
        />
        <SendButton canSend={canSend} sending={sending} onClick={() => void submit()} />
      </div>
      <div className="flex justify-between px-1 font-mono text-[10.5px] text-fg-4">
        <span>
          <Kbd>⏎</Kbd> send · <Kbd>⇧⏎</Kbd> newline
        </span>
        <span>end-to-end via VPS</span>
      </div>
    </div>
  );
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
      title={disabled ? `${title} (coming soon)` : title}
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
      title={disabled ? `${title} (coming soon)` : title}
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
  onClick,
}: {
  canSend: boolean;
  sending: boolean;
  onClick: () => void;
}): JSX.Element {
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
