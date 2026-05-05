import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  VoiceFsm,
  type FsmEffect,
  type FsmState,
  type SessionStatus,
  type SpeechErrorKind,
} from '../lib/voiceFsm';
import type { VoiceScope } from '../types';

const TICK_MS = 100;

export interface UseSpeechRecognitionOptions {
  enabled: boolean;
  sessionStatus: SessionStatus;
  scope: VoiceScope;
  pauseMs: number;
  onAutoSubmit: () => void;
  onTranscriptChange: (text: string) => void;
}

export interface UseSpeechRecognitionResult {
  supported: boolean;
  listening: boolean;
  countingDown: boolean;
  interim: string;
  error: SpeechErrorKind | null;
  cancelCountdown: () => void;
  /** Seed the FSM buffer with text already in the textarea on activation. */
  seedBuffer: (text: string) => void;
  /** Clear the FSM buffer after a successful submit so subsequent speech starts fresh. */
  clearBuffer: () => void;
}

function getCtor(): { new (): SpeechRecognition } | null {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export function useSpeechRecognition(
  opts: UseSpeechRecognitionOptions,
): UseSpeechRecognitionResult {
  const ctor = useMemo(() => getCtor(), []);
  const supported = ctor !== null;

  const fsmRef = useRef<VoiceFsm>(new VoiceFsm({ scope: opts.scope, pauseMs: opts.pauseMs }));
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const [state, setState] = useState<FsmState>(() => fsmRef.current.getState());

  const callbacksRef = useRef({
    onAutoSubmit: opts.onAutoSubmit,
    onTranscriptChange: opts.onTranscriptChange,
  });
  useEffect(() => {
    callbacksRef.current.onAutoSubmit = opts.onAutoSubmit;
    callbacksRef.current.onTranscriptChange = opts.onTranscriptChange;
  }, [opts.onAutoSubmit, opts.onTranscriptChange]);

  // Keep FSM config and status mirrored.
  useEffect(() => {
    fsmRef.current.setConfig({ scope: opts.scope, pauseMs: opts.pauseMs });
  }, [opts.scope, opts.pauseMs]);

  useEffect(() => {
    fsmRef.current.setStatus(opts.sessionStatus);
    applyEffects(
      fsmRef.current.dispatch({
        kind: 'status-change',
        status: opts.sessionStatus,
        nowMs: Date.now(),
      }),
    );
    setState(fsmRef.current.getState());
  }, [opts.sessionStatus]);

  // Apply FSM effects to the actual SpeechRecognition instance.
  const applyEffects = useCallback((effects: FsmEffect[]): void => {
    for (const effect of effects) {
      if (effect.kind === 'start-recognition') startRecognition();
      else if (effect.kind === 'stop-recognition') stopRecognition();
      else if (effect.kind === 'auto-submit') callbacksRef.current.onAutoSubmit();
    }
  }, []);

  const startRecognition = (): void => {
    if (!ctor) return;
    if (recognitionRef.current) return; // already running
    const rec = new ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
    rec.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alt = result[0];
        if (!alt) continue;
        if (result.isFinal) finalText += alt.transcript;
        else interim += alt.transcript;
      }
      const now = Date.now();
      if (finalText.length > 0) {
        applyEffects(
          fsmRef.current.dispatch({ kind: 'final-result', text: finalText.trim(), nowMs: now }),
        );
      }
      if (interim.length > 0) {
        applyEffects(
          fsmRef.current.dispatch({ kind: 'interim-result', text: interim, nowMs: now }),
        );
      }
      const next = fsmRef.current.getState();
      setState(next);
      callbacksRef.current.onTranscriptChange(next.buffer);
    };
    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      const kind = mapErrorKind(event.error);
      applyEffects(fsmRef.current.dispatch({ kind: 'recognition-error', error: kind }));
      setState(fsmRef.current.getState());
    };
    rec.onend = () => {
      if (recognitionRef.current === rec) recognitionRef.current = null;
      applyEffects(fsmRef.current.dispatch({ kind: 'recognition-end', nowMs: Date.now() }));
      setState(fsmRef.current.getState());
    };
    try {
      rec.start();
      recognitionRef.current = rec;
    } catch {
      // start() throws if called too rapidly after stop(); next tick will retry via end-event.
    }
  };

  const stopRecognition = (): void => {
    const rec = recognitionRef.current;
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      /* ignore */
    }
    if (recognitionRef.current === rec) recognitionRef.current = null;
  };

  // Drive enable/disable based on opts.enabled.
  useEffect(() => {
    if (opts.enabled) {
      applyEffects(fsmRef.current.dispatch({ kind: 'enable', nowMs: Date.now() }));
    } else {
      applyEffects(fsmRef.current.dispatch({ kind: 'disable' }));
    }
    setState(fsmRef.current.getState());
  }, [opts.enabled]);

  // Periodic tick.
  useEffect(() => {
    if (!opts.enabled) return;
    const id = window.setInterval(() => {
      applyEffects(fsmRef.current.dispatch({ kind: 'tick', nowMs: Date.now() }));
      setState(fsmRef.current.getState());
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [opts.enabled]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => stopRecognition();
  }, []);

  const cancelCountdown = useCallback((): void => {
    applyEffects(fsmRef.current.dispatch({ kind: 'cancel-countdown' }));
    setState(fsmRef.current.getState());
  }, [applyEffects]);

  const seedBuffer = useCallback((text: string): void => {
    fsmRef.current.seedBuffer(text);
  }, []);

  const clearBuffer = useCallback((): void => {
    fsmRef.current.clearBuffer();
  }, []);

  return {
    supported,
    listening: state.listening,
    countingDown: state.countingDown,
    interim: state.interim,
    error: state.error,
    cancelCountdown,
    seedBuffer,
    clearBuffer,
  };
}

function mapErrorKind(error: string): SpeechErrorKind {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'not-allowed';
    case 'audio-capture':
      return 'audio-capture';
    case 'network':
      return 'network';
    case 'aborted':
      return 'aborted';
    case 'no-speech':
      return 'no-speech';
    default:
      return 'unknown';
  }
}
