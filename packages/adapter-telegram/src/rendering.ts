/**
 * Render plain or loosely-Markdown text into a Telegram MarkdownV2-safe string.
 *
 * Preserves fenced code blocks, inline code, **bold**, and _italic_. Everything
 * else is escaped for MarkdownV2.
 *
 * Telegram MarkdownV2 reserved chars (per Bot API docs):
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 */

const MARKDOWNV2_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

const FENCE_MARKER = '\u0000FENCE\u0000';
const INLINE_MARKER = '\u0000INLINE\u0000';
const BOLD_MARKER = '\u0000BOLD\u0000';
const ITALIC_MARKER = '\u0000ITAL\u0000';

function escapeMdv2(text: string): string {
  return text.replace(MARKDOWNV2_RESERVED, '\\$&');
}

export interface RenderResult {
  text: string;
  parse_mode: 'MarkdownV2' | undefined;
}

export function renderToMarkdownV2(input: string): RenderResult {
  // Pull out fenced code blocks first. In MarkdownV2 code blocks, only ` and \ need escaping.
  const fences: string[] = [];
  let work = input.replace(
    /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g,
    (_m, _lang: string, body: string) => {
      const idx = fences.length;
      const escapedBody = body.replace(/([`\\])/g, '\\$1');
      fences.push('```\n' + escapedBody + '```');
      return `${FENCE_MARKER}${idx}${FENCE_MARKER}`;
    },
  );

  // Inline code (`...`)
  const inlines: string[] = [];
  work = work.replace(/`([^`\n]+)`/g, (_m, body: string) => {
    const idx = inlines.length;
    inlines.push('`' + body.replace(/([`\\])/g, '\\$1') + '`');
    return `${INLINE_MARKER}${idx}${INLINE_MARKER}`;
  });

  // Bold: **text** → *text*
  const bolds: string[] = [];
  work = work.replace(/\*\*([^*\n]+)\*\*/g, (_m, body: string) => {
    const idx = bolds.length;
    bolds.push('*' + escapeMdv2(body) + '*');
    return `${BOLD_MARKER}${idx}${BOLD_MARKER}`;
  });

  // Italic: _text_
  const italics: string[] = [];
  work = work.replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, (_m, body: string) => {
    const idx = italics.length;
    italics.push('_' + escapeMdv2(body) + '_');
    return `${ITALIC_MARKER}${idx}${ITALIC_MARKER}`;
  });

  // Escape the remaining plain prose. Markers use \u0000 which is not reserved.
  work = escapeMdv2(work);

  // Restore markers.
  work = work.replace(
    new RegExp(`${FENCE_MARKER}(\\d+)${FENCE_MARKER}`, 'g'),
    (_m, i: string) => fences[Number(i)]!,
  );
  work = work.replace(
    new RegExp(`${INLINE_MARKER}(\\d+)${INLINE_MARKER}`, 'g'),
    (_m, i: string) => inlines[Number(i)]!,
  );
  work = work.replace(
    new RegExp(`${BOLD_MARKER}(\\d+)${BOLD_MARKER}`, 'g'),
    (_m, i: string) => bolds[Number(i)]!,
  );
  work = work.replace(
    new RegExp(`${ITALIC_MARKER}(\\d+)${ITALIC_MARKER}`, 'g'),
    (_m, i: string) => italics[Number(i)]!,
  );

  return { text: work, parse_mode: 'MarkdownV2' };
}

/**
 * Fallback renderer that escapes all text for MarkdownV2 without trying to
 * preserve any formatting.
 */
export function renderPlain(input: string): RenderResult {
  return { text: escapeMdv2(input), parse_mode: 'MarkdownV2' };
}
