export type ClassifiedEntry =
  | { kind: 'local-user'; uuid: string; timestamp: string; text: string }
  | { kind: 'local-assistant'; uuid: string; timestamp: string; text: string };

interface RawEntry {
  type?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown; content?: unknown } | undefined;
}

const CHANNEL_MARKER = '<channel source="reder">';
const REDER_REPLY_TOOL = 'mcp__reder__reply';

export function classifyTranscriptLine(raw: string): ClassifiedEntry | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: RawEntry;
  try {
    parsed = JSON.parse(trimmed) as RawEntry;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const uuid = typeof parsed.uuid === 'string' ? parsed.uuid : null;
  const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : null;
  if (!uuid || !timestamp) return null;

  const content = parsed.message?.content;

  if (parsed.type === 'user') {
    const text = extractUserText(content);
    if (text === null) return null;
    if (text.includes(CHANNEL_MARKER)) return null;
    return { kind: 'local-user', uuid, timestamp, text };
  }

  if (parsed.type === 'assistant') {
    const text = extractAssistantText(content);
    if (text === null) return null;
    return { kind: 'local-assistant', uuid, timestamp, text };
  }

  return null;
}

function extractUserText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_result' || block.type === 'tool_use') {
      return null;
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function extractAssistantText(content: unknown): string | null {
  if (typeof content === 'string') return content.length > 0 ? content : null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content as Array<{ type?: unknown; text?: unknown; name?: unknown }>) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
    // tool_use blocks contribute no text; the reder reply tool is tracked via
    // reply_tool_call elsewhere, so an assistant turn that only contains it
    // collapses to empty text and we return null (nothing to record).
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}
