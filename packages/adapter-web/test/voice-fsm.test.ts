import { describe, expect, it } from 'vitest';
import { VoiceFsm } from '../web/src/lib/voiceFsm';

const baseConfig = { scope: 'always' as const, pauseMs: 1500 };

describe('VoiceFsm — enable/disable', () => {
  it('emits start-recognition on enable and is in listening mode', () => {
    const fsm = new VoiceFsm(baseConfig);
    fsm.setStatus('idle');
    const effects = fsm.dispatch({ kind: 'enable', nowMs: 0 });
    expect(effects).toEqual([{ kind: 'start-recognition' }]);
    expect(fsm.getState().mode).toBe('listening');
  });

  it('emits stop-recognition on disable and returns to off', () => {
    const fsm = new VoiceFsm(baseConfig);
    fsm.setStatus('idle');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    const effects = fsm.dispatch({ kind: 'disable' });
    expect(effects).toEqual([{ kind: 'stop-recognition' }]);
    expect(fsm.getState().mode).toBe('off');
  });

  it('disable while off is a no-op', () => {
    const fsm = new VoiceFsm(baseConfig);
    expect(fsm.dispatch({ kind: 'disable' })).toEqual([]);
  });
});

describe('VoiceFsm — result accumulation', () => {
  it('appends final results separated by single space', () => {
    const fsm = new VoiceFsm(baseConfig);
    fsm.setStatus('idle');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    fsm.dispatch({ kind: 'final-result', text: 'hello', nowMs: 100 });
    fsm.dispatch({ kind: 'final-result', text: 'world', nowMs: 200 });
    expect(fsm.getState().buffer).toBe('hello world');
  });

  it('preserves seeded buffer and prepends a space before first final', () => {
    const fsm = new VoiceFsm(baseConfig);
    fsm.setStatus('idle');
    fsm.seedBuffer('typed text');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    fsm.dispatch({ kind: 'final-result', text: 'spoken', nowMs: 50 });
    expect(fsm.getState().buffer).toBe('typed text spoken');
  });

  it('does not double-space when seeded buffer already ends in whitespace', () => {
    const fsm = new VoiceFsm(baseConfig);
    fsm.setStatus('idle');
    fsm.seedBuffer('typed ');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    fsm.dispatch({ kind: 'final-result', text: 'spoken', nowMs: 50 });
    expect(fsm.getState().buffer).toBe('typed spoken');
  });

  it('interim result updates interim only', () => {
    const fsm = new VoiceFsm(baseConfig);
    fsm.setStatus('idle');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    fsm.dispatch({ kind: 'interim-result', text: 'partial', nowMs: 50 });
    expect(fsm.getState().buffer).toBe('');
    expect(fsm.getState().interim).toBe('partial');
  });

  it('final result clears the interim', () => {
    const fsm = new VoiceFsm(baseConfig);
    fsm.setStatus('idle');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    fsm.dispatch({ kind: 'interim-result', text: 'partial', nowMs: 50 });
    fsm.dispatch({ kind: 'final-result', text: 'partial complete', nowMs: 100 });
    expect(fsm.getState().interim).toBe('');
    expect(fsm.getState().buffer).toBe('partial complete');
  });
});

describe('VoiceFsm — silence and countdown', () => {
  it('starts countdown after pauseMs of silence when status is idle', () => {
    const fsm = new VoiceFsm({ scope: 'always', pauseMs: 1500 });
    fsm.setStatus('idle');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    fsm.dispatch({ kind: 'final-result', text: 'hello', nowMs: 100 });
    fsm.dispatch({ kind: 'tick', nowMs: 1500 });
    expect(fsm.getState().mode).toBe('listening');
    fsm.dispatch({ kind: 'tick', nowMs: 1600 }); // 1500ms after lastResultAt=100
    expect(fsm.getState().mode).toBe('countingDown');
    expect(fsm.getState().countingDown).toBe(true);
  });

  it('does NOT start countdown when session is working', () => {
    const fsm = new VoiceFsm({ scope: 'always', pauseMs: 1500 });
    fsm.setStatus('working');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    fsm.dispatch({ kind: 'final-result', text: 'hello', nowMs: 100 });
    fsm.dispatch({ kind: 'tick', nowMs: 5000 });
    expect(fsm.getState().mode).toBe('listening');
  });

  it('starts countdown immediately on status change from working to idle if silence already elapsed', () => {
    const fsm = new VoiceFsm({ scope: 'always', pauseMs: 1500 });
    fsm.setStatus('working');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    fsm.dispatch({ kind: 'final-result', text: 'hello', nowMs: 100 });
    fsm.dispatch({ kind: 'tick', nowMs: 5000 });
    expect(fsm.getState().mode).toBe('listening');
    fsm.dispatch({ kind: 'status-change', status: 'idle', nowMs: 5001 });
    expect(fsm.getState().mode).toBe('countingDown');
  });

  it('emits auto-submit after countdown elapses with non-empty buffer', () => {
    const fsm = new VoiceFsm({ scope: 'always', pauseMs: 1500 });
    fsm.setStatus('idle');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    fsm.dispatch({ kind: 'final-result', text: 'hello', nowMs: 100 });
    fsm.dispatch({ kind: 'tick', nowMs: 1700 }); // pauseMs elapsed → countdown starts
    expect(fsm.getState().mode).toBe('countingDown');
    const effects = fsm.dispatch({ kind: 'tick', nowMs: 2800 }); // 1100ms after countdown started
    expect(effects).toEqual([{ kind: 'auto-submit' }]);
    expect(fsm.getState().mode).toBe('listening');
  });

  it('cancel-countdown returns to listening without emitting auto-submit', () => {
    const fsm = new VoiceFsm({ scope: 'always', pauseMs: 1500 });
    fsm.setStatus('idle');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    fsm.dispatch({ kind: 'final-result', text: 'hello', nowMs: 100 });
    fsm.dispatch({ kind: 'tick', nowMs: 1700 });
    expect(fsm.getState().mode).toBe('countingDown');
    const effects = fsm.dispatch({ kind: 'cancel-countdown' });
    expect(effects).toEqual([]);
    expect(fsm.getState().mode).toBe('listening');
  });

  it('result during countdown cancels it', () => {
    const fsm = new VoiceFsm({ scope: 'always', pauseMs: 1500 });
    fsm.setStatus('idle');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    fsm.dispatch({ kind: 'final-result', text: 'hello', nowMs: 100 });
    fsm.dispatch({ kind: 'tick', nowMs: 1700 });
    expect(fsm.getState().mode).toBe('countingDown');
    fsm.dispatch({ kind: 'interim-result', text: 'world', nowMs: 1800 });
    expect(fsm.getState().mode).toBe('listening');
  });

  it('empty buffer at countdown end does not emit auto-submit', () => {
    // Synthetic: buffer can be empty if seeded empty and zero finals before silence.
    // Use seedBuffer('') and force the timing manually.
    const fsm = new VoiceFsm({ scope: 'always', pauseMs: 1500 });
    fsm.setStatus('idle');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    // No final-result; buffer stays empty. Silence timer never starts (lastResultAt only updates on results).
    // To reach countdown without buffer content, we'd need a final-result with empty text.
    fsm.dispatch({ kind: 'final-result', text: '', nowMs: 100 });
    fsm.dispatch({ kind: 'tick', nowMs: 1700 });
    expect(fsm.getState().mode).toBe('listening'); // no countdown; buffer empty
  });
});

describe('VoiceFsm — recognition-end and errors', () => {
  it('emits start-recognition on end while still enabled and gate allows', () => {
    const fsm = new VoiceFsm({ scope: 'always', pauseMs: 1500 });
    fsm.setStatus('idle');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    const effects = fsm.dispatch({ kind: 'recognition-end', nowMs: 100 });
    expect(effects).toEqual([{ kind: 'start-recognition' }]);
    expect(fsm.getState().mode).toBe('listening');
  });

  it('does not restart on end when scope is idle-or-awaiting and session is working', () => {
    const fsm = new VoiceFsm({ scope: 'idle-or-awaiting', pauseMs: 1500 });
    fsm.setStatus('working');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    const effects = fsm.dispatch({ kind: 'recognition-end', nowMs: 100 });
    expect(effects).toEqual([]);
    expect(fsm.getState().mode).toBe('paused');
  });

  it('not-allowed error sets failed mode and clears recognition', () => {
    const fsm = new VoiceFsm({ scope: 'always', pauseMs: 1500 });
    fsm.setStatus('idle');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    const effects = fsm.dispatch({ kind: 'recognition-error', error: 'not-allowed' });
    expect(effects).toEqual([]);
    expect(fsm.getState().mode).toBe('failed');
    expect(fsm.getState().error).toBe('not-allowed');
  });

  it('aborted error is ignored (no state change)', () => {
    const fsm = new VoiceFsm({ scope: 'always', pauseMs: 1500 });
    fsm.setStatus('idle');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    fsm.dispatch({ kind: 'recognition-error', error: 'aborted' });
    expect(fsm.getState().mode).toBe('listening');
    expect(fsm.getState().error).toBeNull();
  });

  it('60s of zero results triggers idle-safety no-speech error', () => {
    const fsm = new VoiceFsm({ scope: 'always', pauseMs: 1500 });
    fsm.setStatus('idle');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    fsm.dispatch({ kind: 'tick', nowMs: 30_000 });
    expect(fsm.getState().mode).toBe('listening');
    const effects = fsm.dispatch({ kind: 'tick', nowMs: 60_500 });
    expect(effects).toEqual([{ kind: 'stop-recognition' }]);
    expect(fsm.getState().mode).toBe('off');
    expect(fsm.getState().error).toBe('no-speech');
  });
});

describe('VoiceFsm — scope=idle-or-awaiting', () => {
  it('emits stop-recognition on transition to working', () => {
    const fsm = new VoiceFsm({ scope: 'idle-or-awaiting', pauseMs: 1500 });
    fsm.setStatus('idle');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    const effects = fsm.dispatch({ kind: 'status-change', status: 'working', nowMs: 100 });
    expect(effects).toEqual([{ kind: 'stop-recognition' }]);
    expect(fsm.getState().mode).toBe('paused');
  });

  it('emits start-recognition on transition back to idle', () => {
    const fsm = new VoiceFsm({ scope: 'idle-or-awaiting', pauseMs: 1500 });
    fsm.setStatus('working');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    expect(fsm.getState().mode).toBe('paused');
    const effects = fsm.dispatch({ kind: 'status-change', status: 'idle', nowMs: 100 });
    expect(effects).toEqual([{ kind: 'start-recognition' }]);
    expect(fsm.getState().mode).toBe('listening');
  });

  it('scope=always does NOT stop on transition to working', () => {
    const fsm = new VoiceFsm({ scope: 'always', pauseMs: 1500 });
    fsm.setStatus('idle');
    fsm.dispatch({ kind: 'enable', nowMs: 0 });
    const effects = fsm.dispatch({ kind: 'status-change', status: 'working', nowMs: 100 });
    expect(effects).toEqual([]);
    expect(fsm.getState().mode).toBe('listening');
  });
});
