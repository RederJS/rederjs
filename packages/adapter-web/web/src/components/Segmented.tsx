import { cn } from '../cn';

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: SegmentedProps<T>): JSX.Element {
  return (
    <div className="grid grid-flow-col auto-cols-fr gap-0 rounded-md border border-line bg-bg-2 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'rounded-[4px] px-2 py-1 font-mono text-[10.5px] text-fg-3 transition-colors',
            value === opt.value && 'bg-bg-3 text-fg shadow-[inset_0_0_0_1px_var(--line-2)]',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
