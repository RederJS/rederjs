/**
 * Split a message longer than Telegram's 4096 char limit. Preferred split
 * points in priority order: fenced code boundary, paragraph (\n\n), newline,
 * space, hard cutoff. If a chunk ends inside an open fence, close it at the
 * end of this chunk and re-open it at the start of the next.
 */

const DEFAULT_MAX = 4000;

function countFences(s: string): number {
  return (s.match(/```/g) ?? []).length;
}

export function splitMessage(text: string, maxChars: number = DEFAULT_MAX): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let rest = text;
  let carry: string | null = null;

  while (rest.length > 0) {
    const prependLen = carry !== null ? carry.length + 1 : 0;
    const budget = maxChars - prependLen;
    if (budget <= 0) {
      // pathological: maxChars too small for carry; emit whatever remains
      chunks.push(rest);
      break;
    }

    if (rest.length <= budget) {
      const final = carry !== null ? carry + '\n' + rest : rest;
      chunks.push(final);
      break;
    }

    const slice = rest.slice(0, budget);
    let cut = -1;

    const lastFence = slice.lastIndexOf('```');
    if (lastFence > budget * 0.5) cut = lastFence + 3;

    if (cut === -1) {
      const idx = slice.lastIndexOf('\n\n');
      if (idx > budget * 0.4) cut = idx + 2;
    }
    if (cut === -1) {
      const idx = slice.lastIndexOf('\n');
      if (idx > budget * 0.4) cut = idx + 1;
    }
    if (cut === -1) {
      const idx = slice.lastIndexOf(' ');
      if (idx > budget * 0.4) cut = idx + 1;
    }
    if (cut === -1) cut = budget;

    let chunk = rest.slice(0, cut);
    rest = rest.slice(cut);

    if (carry !== null) chunk = carry + '\n' + chunk;
    // Count fences in final chunk
    const fences = countFences(chunk);
    if (fences % 2 === 1) {
      chunk = chunk + '\n```';
      carry = '```';
    } else {
      carry = null;
    }

    chunks.push(chunk);
  }

  return chunks;
}
