import { Fragment, type ReactNode, useMemo } from 'react';

type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'strong'; children: InlineToken[] }
  | { kind: 'em'; children: InlineToken[] }
  | { kind: 'link'; href: string; children: InlineToken[] };

function tokenizeInline(src: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  let buf = '';
  const flush = (): void => {
    if (buf) {
      tokens.push({ kind: 'text', value: buf });
      buf = '';
    }
  };

  while (i < src.length) {
    const c = src[i]!;

    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end !== -1) {
        flush();
        tokens.push({ kind: 'code', value: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (c === '*' && src[i + 1] === '*') {
      const end = src.indexOf('**', i + 2);
      if (end !== -1) {
        flush();
        tokens.push({ kind: 'strong', children: tokenizeInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    if (c === '*') {
      // italic: require non-* before and non-* after, per design's rule
      const prev = i === 0 ? '' : src[i - 1]!;
      if (prev !== '*') {
        const end = src.indexOf('*', i + 1);
        if (end !== -1 && src[end + 1] !== '*') {
          const inner = src.slice(i + 1, end);
          if (!inner.includes('\n') && inner.length > 0) {
            flush();
            tokens.push({ kind: 'em', children: tokenizeInline(inner) });
            i = end + 1;
            continue;
          }
        }
      }
    }

    if (c === '[') {
      const closeBracket = src.indexOf(']', i + 1);
      if (closeBracket !== -1 && src[closeBracket + 1] === '(') {
        const closeParen = src.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const label = src.slice(i + 1, closeBracket);
          const href = src.slice(closeBracket + 2, closeParen);
          flush();
          tokens.push({ kind: 'link', href, children: tokenizeInline(label) });
          i = closeParen + 1;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }

  flush();
  return tokens;
}

function renderInline(tokens: InlineToken[], keyPrefix = ''): ReactNode[] {
  return tokens.map((t, idx) => {
    const key = `${keyPrefix}${idx}`;
    switch (t.kind) {
      case 'text':
        return <Fragment key={key}>{t.value}</Fragment>;
      case 'code':
        return <code key={key}>{t.value}</code>;
      case 'strong':
        return <strong key={key}>{renderInline(t.children, `${key}-`)}</strong>;
      case 'em':
        return <em key={key}>{renderInline(t.children, `${key}-`)}</em>;
      case 'link':
        return (
          <a key={key} href={t.href} target="_blank" rel="noreferrer">
            {renderInline(t.children, `${key}-`)}
          </a>
        );
    }
  });
}

function Inline({ text }: { text: string }): JSX.Element {
  return <>{renderInline(tokenizeInline(text))}</>;
}

interface MdBlock {
  kind: 'h1' | 'h2' | 'h3' | 'p' | 'ul' | 'ol' | 'blockquote' | 'pre';
  text?: string;
  items?: string[];
  lang?: string;
}

function parseBlocks(src: string): MdBlock[] {
  const lines = src.split('\n');
  const out: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, '').trim();
      i++;
      const body: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++;
      out.push({ kind: 'pre', text: body.join('\n'), lang });
      continue;
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const lvl = h[1]!.length;
      out.push({
        kind: lvl === 1 ? 'h1' : lvl === 2 ? 'h2' : 'h3',
        text: h[2]!,
      });
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^>\s?/, ''));
        i++;
      }
      out.push({ kind: 'blockquote', text: body.join(' ') });
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^[-*]\s+/, ''));
        i++;
      }
      out.push({ kind: 'ul', items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\d+\.\s+/, ''));
        i++;
      }
      out.push({ kind: 'ol', items });
      continue;
    }

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]!) &&
      !/^```/.test(lines[i]!) &&
      !/^#{1,3}\s/.test(lines[i]!) &&
      !/^[-*]\s+/.test(lines[i]!) &&
      !/^\d+\.\s+/.test(lines[i]!) &&
      !/^>\s?/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i++;
    }
    out.push({ kind: 'p', text: para.join(' ') });
  }

  return out;
}

export function Markdown({ src }: { src: string }): JSX.Element {
  const blocks = useMemo(() => parseBlocks(src), [src]);
  return (
    <div className="md">
      {blocks.map((b, idx) => {
        const key = String(idx);
        switch (b.kind) {
          case 'h1':
            return (
              <h1 key={key}>
                <Inline text={b.text!} />
              </h1>
            );
          case 'h2':
            return (
              <h2 key={key}>
                <Inline text={b.text!} />
              </h2>
            );
          case 'h3':
            return (
              <h3 key={key}>
                <Inline text={b.text!} />
              </h3>
            );
          case 'p':
            return (
              <p key={key}>
                <Inline text={b.text!} />
              </p>
            );
          case 'blockquote':
            return (
              <blockquote key={key}>
                <Inline text={b.text!} />
              </blockquote>
            );
          case 'pre':
            return (
              <pre key={key}>
                <code data-lang={b.lang}>{b.text}</code>
              </pre>
            );
          case 'ul':
            return (
              <ul key={key}>
                {b.items!.map((it, j) => (
                  <li key={j}>
                    <Inline text={it} />
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key}>
                {b.items!.map((it, j) => (
                  <li key={j}>
                    <Inline text={it} />
                  </li>
                ))}
              </ol>
            );
        }
      })}
    </div>
  );
}
