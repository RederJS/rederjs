import { describe, it, expect } from 'vitest';
import { ShimToDaemon, DaemonToShim, PROTOCOL_VERSION } from '../../src/ipc/protocol.js';

describe('ipc/protocol ShimToDaemon', () => {
  it('parses a valid hello', () => {
    const msg = {
      kind: 'hello',
      session_id: 'booknerds',
      shim_token: 'rdr_sess_abc',
      shim_version: '0.1.0',
      claude_code_version: '2.1.81',
    };
    expect(ShimToDaemon.parse(msg)).toEqual(msg);
  });

  it('rejects hello missing fields', () => {
    expect(() => ShimToDaemon.parse({ kind: 'hello', session_id: 'x' })).toThrow();
  });

  it('parses a reply_tool_call with defaults for meta/files', () => {
    const parsed = ShimToDaemon.parse({
      kind: 'reply_tool_call',
      request_id: 'r1',
      content: 'hello',
    });
    expect(parsed).toMatchObject({ kind: 'reply_tool_call', content: 'hello', meta: {}, files: [] });
  });

  it('parses a permission_request', () => {
    const parsed = ShimToDaemon.parse({
      kind: 'permission_request',
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run npm test',
      input_preview: '{"command":"npm test"}',
    });
    expect(parsed.kind).toBe('permission_request');
  });

  it('parses channel_ack and ping', () => {
    expect(ShimToDaemon.parse({ kind: 'channel_ack', message_id: 'm1' }).kind).toBe('channel_ack');
    expect(ShimToDaemon.parse({ kind: 'ping' }).kind).toBe('ping');
  });

  it('rejects unknown kinds', () => {
    expect(() => ShimToDaemon.parse({ kind: 'garbage' })).toThrow();
  });
});

describe('ipc/protocol DaemonToShim', () => {
  it('parses a welcome', () => {
    const parsed = DaemonToShim.parse({
      kind: 'welcome',
      session_id: 'x',
      protocol_version: PROTOCOL_VERSION,
    });
    expect(parsed.protocol_version).toBe(1);
  });

  it('parses a channel_event', () => {
    const parsed = DaemonToShim.parse({
      kind: 'channel_event',
      message_id: 'm1',
      content: 'hi',
      meta: { chat_id: '12345' },
    });
    expect(parsed.kind).toBe('channel_event');
  });

  it('parses a permission_verdict', () => {
    const parsed = DaemonToShim.parse({
      kind: 'permission_verdict',
      request_id: 'abc',
      behavior: 'allow',
    });
    expect(parsed.kind).toBe('permission_verdict');
  });

  it('rejects permission_verdict with invalid behavior', () => {
    expect(() =>
      DaemonToShim.parse({ kind: 'permission_verdict', request_id: 'a', behavior: 'maybe' }),
    ).toThrow();
  });

  it('parses reply_tool_result with and without error', () => {
    expect(
      DaemonToShim.parse({ kind: 'reply_tool_result', request_id: 'r', success: true }).kind,
    ).toBe('reply_tool_result');
    expect(
      DaemonToShim.parse({
        kind: 'reply_tool_result',
        request_id: 'r',
        success: false,
        error: 'boom',
      }).kind,
    ).toBe('reply_tool_result');
  });

  it('parses error and pong', () => {
    expect(DaemonToShim.parse({ kind: 'error', code: 'AUTH', message: 'bad token' }).kind).toBe(
      'error',
    );
    expect(DaemonToShim.parse({ kind: 'pong' }).kind).toBe('pong');
  });
});
