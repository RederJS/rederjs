import type { VoiceScope } from '../types';

export type SessionStatus = 'working' | 'awaiting-user' | 'idle' | 'unknown' | 'offline';

export type SpeechErrorKind =
  | 'not-allowed'
  | 'audio-capture'
  | 'network'
  | 'aborted'
  | 'no-speech'
  | 'unknown';

export type FsmEvent =
  | { kind: 'enable'; nowMs: number }
  | { kind: 'disable' }
  | { kind: 'final-result'; text: string; nowMs: number }
  | { kind: 'interim-result'; text: string; nowMs: number }
  | { kind: 'recognition-end'; nowMs: number }
  | { kind: 'recognition-error'; error: SpeechErrorKind }
  | { kind: 'status-change'; status: SessionStatus; nowMs: number }
  | { kind: 'tick'; nowMs: number }
  | { kind: 'cancel-countdown' };

export type FsmEffect =
  | { kind: 'start-recognition' }
  | { kind: 'stop-recognition' }
  | { kind: 'auto-submit' };

export interface FsmConfig {
  scope: VoiceScope;
  pauseMs: number;
}

const COUNTDOWN_MS = 1000;
const IDLE_SAFETY_MS = 60_000;

export type FsmMode = 'off' | 'listening' | 'countingDown' | 'paused' | 'failed';

export interface FsmState {
  mode: FsmMode;
  buffer: string;       // committed (final) transcript
  interim: string;      // current interim chunk
  error: SpeechErrorKind | null;
  countingDown: boolean;
  listening: boolean;   // is the recognition currently capturing audio?
}

export class VoiceFsm {
  private mode: FsmMode = 'off';
  private buffer = '';
  private interim = '';
  private error: SpeechErrorKind | null = null;
  private status: SessionStatus = 'unknown';
  private config: FsmConfig;

  // Timestamps in ms (from event nowMs); null when not active.
  private lastResultAt: number | null = null;
  private countdownStartedAt: number | null = null;
  private firstEnabledAt: number | null = null;

  constructor(config: FsmConfig) {
    this.config = config;
  }

  setConfig(next: Partial<FsmConfig>): void {
    this.config = { ...this.config, ...next };
  }

  setStatus(status: SessionStatus): void {
    this.status = status;
  }

  getState(): FsmState {
    return {
      mode: this.mode,
      buffer: this.buffer,
      interim: this.interim,
      error: this.error,
      countingDown: this.mode === 'countingDown',
      listening: this.mode === 'listening' || this.mode === 'countingDown',
    };
  }

  /** Reset committed buffer (called after a successful submit). */
  clearBuffer(): void {
    this.buffer = '';
    this.interim = '';
  }

  /** Seed buffer with text already in the textarea when conversation mode starts. */
  seedBuffer(text: string): void {
    this.buffer = text;
  }

  dispatch(_event: FsmEvent): FsmEffect[] {
    // Implemented in Task 3.
    return [];
  }
}
