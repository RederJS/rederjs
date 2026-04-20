export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export class FrameTooLargeError extends Error {
  override readonly name = 'FrameTooLargeError';
  constructor(public readonly size: number) {
    super(`IPC frame size ${size} exceeds MAX_FRAME_BYTES=${MAX_FRAME_BYTES}`);
  }
}

export function encode(obj: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  if (json.length > MAX_FRAME_BYTES) throw new FrameTooLargeError(json.length);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length, 0);
  return Buffer.concat([prefix, json]);
}

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : (Buffer.concat([this.buf, chunk]) as Buffer);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        throw new FrameTooLargeError(len);
      }
      if (this.buf.length < 4 + len) break;
      const json = this.buf.subarray(4, 4 + len).toString('utf8');
      out.push(JSON.parse(json));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }

  reset(): void {
    this.buf = Buffer.alloc(0) as Buffer;
  }
}
