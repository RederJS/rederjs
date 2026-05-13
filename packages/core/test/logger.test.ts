import { describe, it, expect } from 'vitest';
import { createLogger, REDACTED_MARKER, scrubTokens } from '../src/logger.js';

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

  describe('token scrubbing', () => {
    it('scrubs telegram bot token from log message strings', () => {
      const { lines, dest } = capture();
      const log = createLogger({ level: 'info', destination: dest });
      log.info('telegram api call to bot12345:AAH9z-secretKey_x failed');
      expect(lines[0]).not.toContain('bot12345:AAH9z-secretKey_x');
      expect(lines[0]).toContain('bot<redacted>');
    });

    it('scrubs reder dashboard token from log message strings', () => {
      const { lines, dest } = capture();
      const log = createLogger({ level: 'info', destination: dest });
      log.info('bootstrap url is http://localhost:7781/?token=rdr_web_abcDEF123456');
      expect(lines[0]).not.toContain('rdr_web_abcDEF123456');
      expect(lines[0]).toContain('rdr_<redacted>');
    });

    it('scrubs reder session token from log message strings', () => {
      const { lines, dest } = capture();
      const log = createLogger({ level: 'info', destination: dest });
      log.info('connected with token rdr_sess_xyz789ABC-123');
      expect(lines[0]).not.toContain('rdr_sess_xyz789ABC-123');
      expect(lines[0]).toContain('rdr_<redacted>');
    });

    it('scrubs bot token embedded in error messages', () => {
      const { lines, dest } = capture();
      const log = createLogger({ level: 'info', destination: dest });
      const err = new Error(
        'file download https://api.telegram.org/file/bot42:SuperSecret_token/file.jpg: 401',
      );
      log.warn({ err }, 'photo download failed');
      expect(lines[0]).not.toContain('bot42:SuperSecret_token');
      expect(lines[0]).toContain('bot<redacted>');
    });

    it('scrubs bot token embedded in error stack traces', () => {
      const { lines, dest } = capture();
      const log = createLogger({ level: 'info', destination: dest });
      const err = new Error('boom');
      err.stack =
        'Error: boom\n    at fetch (https://api.telegram.org/bot999:realToken_abc/getUpdates)';
      log.warn({ err }, 'telegram getUpdates failed; retrying');
      expect(lines[0]).not.toContain('bot999:realToken_abc');
    });

    it('leaves non-token text intact', () => {
      const { lines, dest } = capture();
      const log = createLogger({ level: 'info', destination: dest });
      log.info({ user: 'ed', count: 42 }, 'hello world from session 12345');
      expect(lines[0]).toContain('hello world from session 12345');
      expect(lines[0]).toContain('"user":"ed"');
      expect(lines[0]).toContain('"count":42');
    });

    it('scrubTokens leaves non-matching strings unchanged', () => {
      expect(scrubTokens('hello world')).toBe('hello world');
      expect(scrubTokens('https://example.com/foo')).toBe('https://example.com/foo');
      expect(scrubTokens('rdr_unknown_xxx')).toBe('rdr_unknown_xxx');
    });

    it('scrubTokens redacts multiple tokens in one string', () => {
      const input = 'bot1:abc and bot2:def and rdr_web_ghi together';
      const out = scrubTokens(input);
      expect(out).not.toContain('abc');
      expect(out).not.toContain('def');
      expect(out).not.toContain('ghi');
      expect(out.match(/bot<redacted>/g)).toHaveLength(2);
      expect(out).toContain('rdr_<redacted>');
    });
  });
});
