import { describe, it, expect } from 'vitest';
import { encode, FrameDecoder, FrameTooLargeError, MAX_FRAME_BYTES } from '../../src/ipc/codec.js';

describe('ipc/codec', () => {
  it('encodes an object with a 4-byte big-endian length prefix', () => {
    const buf = encode({ kind: 'ping' });
    const len = buf.readUInt32BE(0);
    expect(len).toBe(buf.length - 4);
    expect(buf.subarray(4).toString('utf8')).toBe('{"kind":"ping"}');
  });

  it('decodes a complete frame', () => {
    const dec = new FrameDecoder();
    const out = dec.push(encode({ kind: 'hello', session_id: 'x' }));
    expect(out).toEqual([{ kind: 'hello', session_id: 'x' }]);
  });

  it('decodes a frame delivered one byte at a time', () => {
    const dec = new FrameDecoder();
    const buf = encode({ kind: 'channel_event', message_id: 'm1', content: 'hi' });
    const out: unknown[] = [];
    for (let i = 0; i < buf.length; i++) {
      out.push(...dec.push(buf.subarray(i, i + 1)));
    }
    expect(out).toEqual([{ kind: 'channel_event', message_id: 'm1', content: 'hi' }]);
  });

  it('decodes multiple frames in a single chunk', () => {
    const a = encode({ kind: 'ping' });
    const b = encode({ kind: 'pong' });
    const dec = new FrameDecoder();
    const out = dec.push(Buffer.concat([a, b]));
    expect(out).toEqual([{ kind: 'ping' }, { kind: 'pong' }]);
  });

  it('holds a partial frame until more bytes arrive', () => {
    const dec = new FrameDecoder();
    const buf = encode({ kind: 'hello', session_id: 'x' });
    const first = dec.push(buf.subarray(0, 3));
    expect(first).toEqual([]);
    const second = dec.push(buf.subarray(3));
    expect(second).toEqual([{ kind: 'hello', session_id: 'x' }]);
  });

  it('throws FrameTooLargeError on encode of oversize objects', () => {
    const huge = { data: 'x'.repeat(MAX_FRAME_BYTES + 1) };
    expect(() => encode(huge)).toThrow(FrameTooLargeError);
  });

  it('throws FrameTooLargeError on decode of oversize declared length', () => {
    const dec = new FrameDecoder();
    const bad = Buffer.alloc(4);
    bad.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => dec.push(bad)).toThrow(FrameTooLargeError);
  });

  it('round-trips an array of mixed frames', () => {
    const frames: unknown[] = [
      { kind: 'ping' },
      { kind: 'hello', session_id: 'a', shim_token: 't', shim_version: '0.1.0', claude_code_version: '2.1.81' },
      { kind: 'channel_ack', message_id: 'abc' },
      { kind: 'reply_tool_call', request_id: 'r1', content: 'hello 🌍', meta: {}, files: [] },
    ];
    const buf = Buffer.concat(frames.map((f) => encode(f)));
    const dec = new FrameDecoder();
    expect(dec.push(buf)).toEqual(frames);
  });
});
