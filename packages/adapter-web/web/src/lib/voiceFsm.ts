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

  dispatch(event: FsmEvent): FsmEffect[] {
    switch (event.kind) {
      case 'enable': {
        if (this.mode !== 'off') return [];
        this.error = null;
        this.firstEnabledAt = event.nowMs;
        this.lastResultAt = event.nowMs;
        if (this.shouldRunRecognition()) {
          this.mode = 'listening';
          return [{ kind: 'start-recognition' }];
        }
        this.mode = 'paused';
        return [];
      }
      case 'disable': {
        if (this.mode === 'off') return [];
        const wasListening = this.mode === 'listening' || this.mode === 'countingDown';
        this.mode = 'off';
        this.countdownStartedAt = null;
        this.firstEnabledAt = null;
        return wasListening ? [{ kind: 'stop-recognition' }] : [];
      }
      case 'final-result': {
        if (this.mode === 'off') return [];
        if (event.text.length === 0) {
          this.lastResultAt = event.nowMs;
          return [];
        }
        this.appendFinal(event.text);
        this.interim = '';
        this.lastResultAt = event.nowMs;
        if (this.mode === 'countingDown') {
          this.countdownStartedAt = null;
          this.mode = 'listening';
        }
        return [];
      }
      case 'interim-result': {
        if (this.mode === 'off') return [];
        this.interim = event.text;
        this.lastResultAt = event.nowMs;
        if (this.mode === 'countingDown') {
          this.countdownStartedAt = null;
          this.mode = 'listening';
        }
        return [];
      }
      default:
        return [];
    }
  }

  private appendFinal(text: string): void {
    if (this.buffer.length === 0) {
      this.buffer = text;
      return;
    }
    const needsSpace = !/\s$/.test(this.buffer);
    this.buffer = this.buffer + (needsSpace ? ' ' : '') + text;
  }

  private shouldRunRecognition(): boolean {
    if (this.config.scope === 'always') return true;
    return this.status === 'idle' || this.status === 'awaiting-user';
  }
}
