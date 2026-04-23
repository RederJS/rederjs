/* global React */
// Minimal, safe markdown renderer.
// Supports: **bold**, *italic*, `code`, ```code blocks```, headings, lists, blockquotes, links, line breaks.

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
}

function renderInline(s) {
  s = escapeHtml(s);
  // inline code
  s = s.replace(/`([^`]+)`/g, (_, t) => `<code>${t}</code>`);
  // bold
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // italic
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return s;
}

function renderMarkdown(src) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, '').trim();
      i++;
      const body = [];
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      out.push(
        `<pre><code data-lang="${escapeHtml(lang)}">${escapeHtml(body.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // heading
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${renderInline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderInline(body.join(' '))}</blockquote>`);
      continue;
    }

    // unordered list
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // blank
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // paragraph (collect consecutive non-empty lines)
    const para = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^#{1,3}\s/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(para.join(' '))}</p>`);
  }
  return out.join('');
}

function Markdown({ src }) {
  const html = React.useMemo(() => renderMarkdown(src), [src]);
  return React.createElement('div', {
    dangerouslySetInnerHTML: { __html: html },
  });
}

window.Markdown = Markdown;
