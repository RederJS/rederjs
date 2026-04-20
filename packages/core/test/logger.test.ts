import { describe, it, expect } from 'vitest';
import { createLogger, REDACTED_MARKER } from '../src/logger.js';

function capture(): { lines: string[]; dest: { write(s: string): void } } {
  const lines: string[] = [];
  return { lines, dest: { write: (s: string) => lines.push(s) } };
}

describe('logger', () => {
  it('redacts registered secret paths', () => {
    const { lines, dest } = capture();
    const log = createLogger({ level: 'info', destination: dest });
    log.info({ token: 'secret-abc', user: 'ed' }, 'hello');
    expect(lines[0]).not.toContain('secret-abc');
    expect(lines[0]).toContain(REDACTED_MARKER);
    expect(lines[0]).toContain('"user":"ed"');
  });

  it('redacts nested api_key fields', () => {
    const { lines, dest } = capture();
    const log = createLogger({ level: 'info', destination: dest });
    log.info({ config: { telegram: { api_key: 'k123' } } }, 'start');
    expect(lines[0]).not.toContain('k123');
    expect(lines[0]).toContain(REDACTED_MARKER);
  });

  it('redacts shim_token and bot_token', () => {
    const { lines, dest } = capture();
    const log = createLogger({ level: 'info', destination: dest });
    log.info({ shim_token: 'rdr_sess_xxx', bot_token: '123:abc' }, 'connected');
    expect(lines[0]).not.toContain('rdr_sess_xxx');
    expect(lines[0]).not.toContain('123:abc');
  });

  it('redacts message_body at info level', () => {
    const { lines, dest } = capture();
    const log = createLogger({ level: 'info', destination: dest });
    log.info({ message_body: 'hi from user' }, 'received');
    expect(lines[0]).not.toContain('hi from user');
    expect(lines[0]).toContain(REDACTED_MARKER);
  });

  it('exposes child loggers with component binding', () => {
    const { lines, dest } = capture();
    const log = createLogger({ level: 'info', destination: dest });
    const child = log.child({ component: 'adapter.telegram' });
    child.info('started');
    expect(lines[0]).toContain('"component":"adapter.telegram"');
  });

  it('respects level filter', () => {
    const { lines, dest } = capture();
    const log = createLogger({ level: 'warn', destination: dest });
    log.debug('quiet');
    log.info('also quiet');
    log.warn('loud');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('loud');
  });
});
