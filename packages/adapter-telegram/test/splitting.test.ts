import { describe, it, expect } from 'vitest';
import { splitMessage } from '../src/splitting.js';

describe('splitMessage', () => {
  it('returns input unchanged when under the limit', () => {
    expect(splitMessage('short', 100)).toEqual(['short']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'a'.repeat(50) + '\n\n' + 'b'.repeat(50) + '\n\n' + 'c'.repeat(50);
    const chunks = splitMessage(text, 70);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(70);
  });

  it('splits on newlines when paragraph too big', () => {
    const text = Array(10).fill('x'.repeat(20)).join('\n');
    const chunks = splitMessage(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(50);
  });

  it('closes unopened code fences across chunk boundaries', () => {
    // 1000 bytes of code inside a single fence; split at 400 bytes.
    const text = '```js\n' + 'foo.bar();\n'.repeat(100) + '```';
    const chunks = splitMessage(text, 400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const fences = c.match(/```/g) ?? [];
      expect(fences.length % 2).toBe(0);
    }
  });

  it('falls back to hard cutoff on pathological input', () => {
    const text = 'x'.repeat(100);
    const chunks = splitMessage(text, 30);
    // When there's nowhere better to split, we still chunk.
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
  });
});
