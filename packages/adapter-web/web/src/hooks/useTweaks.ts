import { useCallback, useEffect, useState } from 'react';
import { ACCENT_HEX, DEFAULT_TWEAKS, type Tweaks } from '../types';

const STORAGE_KEY = 'reder.tweaks';

function loadTweaks(): Tweaks {
  if (typeof window === 'undefined') return DEFAULT_TWEAKS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TWEAKS;
    const parsed = JSON.parse(raw) as Partial<Tweaks>;
    const merged = { ...DEFAULT_TWEAKS, ...parsed };
    if (merged.voiceScope !== 'always' && merged.voiceScope !== 'idle-or-awaiting') {
      merged.voiceScope = DEFAULT_TWEAKS.voiceScope;
    }
    const ms = Number(merged.voicePauseMs);
    merged.voicePauseMs = Number.isFinite(ms) ? Math.max(500, Math.min(4000, Math.round(ms))) : DEFAULT_TWEAKS.voicePauseMs;
    return merged;
  } catch {
    return DEFAULT_TWEAKS;
  }
}

function apply(tweaks: Tweaks): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', tweaks.theme);
  root.style.setProperty('--accent', ACCENT_HEX[tweaks.accent]);
}

export interface UseTweaks {
  tweaks: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  resetTweaks: () => void;
}

export function useTweaks(): UseTweaks {
  const [tweaks, setTweaks] = useState<Tweaks>(() => loadTweaks());

  useEffect(() => {
    apply(tweaks);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tweaks));
    } catch {
      // localStorage may be unavailable; ignore
    }
  }, [tweaks]);

  const setTweak = useCallback(<K extends keyof Tweaks>(key: K, value: Tweaks[K]) => {
    setTweaks((prev) => ({ ...prev, [key]: value }));
  }, []);

  const resetTweaks = useCallback(() => setTweaks(DEFAULT_TWEAKS), []);

  return { tweaks, setTweak, resetTweaks };
}
