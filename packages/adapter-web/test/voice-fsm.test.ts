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
