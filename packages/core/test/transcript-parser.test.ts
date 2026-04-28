import { describe, it, expect } from 'vitest';
import { classifyTranscriptLine } from '../src/transcript-parser.js';

describe('classifyTranscriptLine', () => {
  it('returns null for non-JSON', () => {
    expect(classifyTranscriptLine('not json')).toBeNull();
  });

  it('returns null for unknown type', () => {
    expect(
      classifyTranscriptLine(
        JSON.stringify({ type: 'system', uuid: 's-1', timestamp: '2026-04-24T12:00:00Z' }),
      ),
    ).toBeNull();
  });

  it('classifies a plain user prompt as local-user', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      timestamp: '2026-04-24T12:00:00Z',
      message: { role: 'user', content: 'hello world' },
    });
    expect(classifyTranscriptLine(line)).toEqual({
      kind: 'local-user',
      uuid: 'u-1',
      timestamp: '2026-04-24T12:00:00Z',
      text: 'hello world',
    });
  });

  it('extracts text from array-content user prompts', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u-2',
      timestamp: '2026-04-24T12:00:01Z',
      message: { role: 'user', content: [{ type: 'text', text: 'combined prompt' }] },
    });
    expect(classifyTranscriptLine(line)?.kind).toBe('local-user');
    expect(classifyTranscriptLine(line)).toMatchObject({ text: 'combined prompt' });
  });

  it('skips user prompts containing <channel source="reder">', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u-3',
      timestamp: '2026-04-24T12:00:02Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<channel source="reder">relayed</channel>' }],
      },
    });
    expect(classifyTranscriptLine(line)).toBeNull();
  });

  it('skips user prompts containing the attributed channel form', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u-3a',
      timestamp: '2026-04-24T12:00:02Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<channel source="reder" attachments="[{&quot;path&quot;:&quot;/x/y.png&quot;}]">hi</channel>',
          },
        ],
      },
    });
    expect(classifyTranscriptLine(line)).toBeNull();
  });

  it('classifies a plain assistant message as local-assistant', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'a-1',
      timestamp: '2026-04-24T12:00:03Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reply one' },
          { type: 'text', text: 'reply two' },
        ],
      },
    });
    expect(classifyTranscriptLine(line)).toEqual({
      kind: 'local-assistant',
      uuid: 'a-1',
      timestamp: '2026-04-24T12:00:03Z',
      text: 'reply one\n\nreply two',
    });
  });

  it('skips assistant turns that only contain the mcp reder reply tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'a-2',
      timestamp: '2026-04-24T12:00:04Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'mcp__reder__reply', input: { content: 'x' } }],
      },
    });
    expect(classifyTranscriptLine(line)).toBeNull();
  });

  it('keeps text blocks from assistant turns that also call tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'a-3',
      timestamp: '2026-04-24T12:00:05Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'about to run' },
          { type: 'tool_use', name: 'Bash', input: {} },
        ],
      },
    });
    expect(classifyTranscriptLine(line)).toMatchObject({
      kind: 'local-assistant',
      text: 'about to run',
    });
  });

  it('skips user tool_result entries', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u-4',
      timestamp: '2026-04-24T12:00:06Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: '...' }],
      },
    });
    expect(classifyTranscriptLine(line)).toBeNull();
  });
});
