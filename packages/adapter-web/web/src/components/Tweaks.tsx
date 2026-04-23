import { Icons } from './Icon';
import { Segmented } from './Segmented';
import { ACCENT_HEX, type Accent, type Tweaks as TweakState } from '../types';
import type { UseTweaks } from '../hooks/useTweaks';
import { cn } from '../cn';

interface TweaksProps {
  tweaks: TweakState;
  setTweak: UseTweaks['setTweak'];
  onClose: () => void;
}

const ACCENTS: Accent[] = ['blue', 'mint', 'amber', 'coral', 'violet'];

export function Tweaks({ tweaks, setTweak, onClose }: TweaksProps): JSX.Element {
  return (
    <>
      <div
        className="fixed inset-0 z-[99] bg-black/35 backdrop-blur-[1.5px] animate-scrim-in"
        onClick={onClose}
      />
      <aside className="fixed bottom-5 right-5 z-[100] flex max-h-[82vh] w-[300px] flex-col overflow-hidden rounded-[12px] border border-accent bg-bg shadow-tweaks animate-tweak-in">
        <div
          className="h-[3px]"
          style={{
            background:
              'linear-gradient(90deg, var(--accent), color-mix(in oklab, var(--accent) 50%, transparent))',
          }}
        />
        <div
          className="flex items-center gap-2.5 border-b border-line px-3.5 py-3 text-accent"
          style={{ background: 'color-mix(in oklab, var(--accent) 8%, var(--bg-1))' }}
        >
          <span
            className="size-[7px] rounded-full animate-dot-blink-slow"
            style={{ background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)' }}
          />
          <Icons.settings size={14} />
          <span className="flex-1 font-mono text-xs font-bold uppercase tracking-[0.08em]">
            Tweaks
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-[22px] place-items-center rounded text-fg-4 hover:bg-bg-3 hover:text-fg"
          >
            <Icons.close size={14} />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto bg-bg-1 p-3.5">
          <Row label="Theme" value={tweaks.theme}>
            <Segmented
              value={tweaks.theme}
              onChange={(v) => setTweak('theme', v)}
              options={[
                { value: 'dark', label: 'dark' },
                { value: 'light', label: 'light' },
              ]}
            />
          </Row>

          <Row label="Accent" value={tweaks.accent}>
            <div className="flex gap-1.5">
              {ACCENTS.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setTweak('accent', a)}
                  aria-label={a}
                  title={a}
                  className={cn(
                    'size-[22px] rounded-full border-2 outline transition-[outline-color]',
                    a === tweaks.accent ? 'outline-2 outline-fg' : 'outline-1 outline-line',
                  )}
                  style={{ background: ACCENT_HEX[a], borderColor: 'var(--bg-1)' }}
                />
              ))}
            </div>
          </Row>

          <Row label="Grid density" value={String(tweaks.cols)}>
            <input
              type="range"
              min={2}
              max={8}
              value={tweaks.cols}
              onChange={(e) => setTweak('cols', Number(e.target.value))}
              className="cols-slider-range w-full"
            />
          </Row>

          <Row label="Card variant" value={tweaks.card}>
            <Segmented
              value={tweaks.card}
              onChange={(v) => setTweak('card', v)}
              options={[
                { value: 'tactical', label: 'tactical' },
                { value: 'panel', label: 'panel' },
                { value: 'compact', label: 'compact' },
              ]}
            />
          </Row>

          <Row label="Status viz" value={tweaks.status}>
            <Segmented
              value={tweaks.status}
              onChange={(v) => setTweak('status', v)}
              options={[
                { value: 'ringed', label: 'ring' },
                { value: 'corner', label: 'dot' },
                { value: 'pill', label: 'pill' },
              ]}
            />
          </Row>

          <Row label="Bubble style" value={tweaks.bubble}>
            <Segmented
              value={tweaks.bubble}
              onChange={(v) => setTweak('bubble', v)}
              options={[
                { value: 'classic', label: 'classic' },
                { value: 'terminal', label: 'terminal' },
                { value: 'minimal', label: 'minimal' },
              ]}
            />
          </Row>

          <Row label="Composer" value={tweaks.composer}>
            <Segmented
              value={tweaks.composer}
              onChange={(v) => setTweak('composer', v)}
              options={[
                { value: 'rail', label: 'rail' },
                { value: 'segmented', label: 'segmented' },
                { value: 'minimal', label: 'minimal' },
              ]}
            />
          </Row>

          <Row label="Side panel" value={tweaks.panel}>
            <Segmented
              value={tweaks.panel}
              onChange={(v) => setTweak('panel', v)}
              options={[
                { value: 'push', label: 'push' },
                { value: 'overlay', label: 'overlay' },
                { value: 'takeover', label: 'takeover' },
              ]}
            />
          </Row>
        </div>
      </aside>
    </>
  );
}

function Row({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
        <span>{label}</span>
        <b className="font-semibold text-fg">{value}</b>
      </div>
      {children}
    </div>
  );
}
