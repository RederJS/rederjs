import type { BubbleVariant } from '../types';
import { cn } from '../cn';

interface TypingIndicatorProps {
  bubbleVariant: BubbleVariant;
}

export function TypingIndicator({ bubbleVariant }: TypingIndicatorProps): JSX.Element {
  const bubbleStyles =
    bubbleVariant === 'terminal'
      ? 'border-0 border-l-2 bg-transparent pl-3 py-1 rounded-none font-mono border-line text-fg-3'
      : bubbleVariant === 'minimal'
        ? 'border-0 bg-transparent px-0 py-0 rounded-none text-fg-3'
        : 'rounded-[10px] rounded-tl-[3px] border border-line bg-bubble-them text-fg-3 px-3 py-2.5';

  return (
    <div aria-label="claude is typing" role="status" className="max-w-[88%] self-start">
      <div className={cn('inline-flex items-center', bubbleStyles)}>
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
    </div>
  );
}
