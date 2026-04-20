import { describe, it, expect } from 'vitest';
import { renderToMarkdownV2, renderPlain } from '../src/rendering.js';

describe('renderToMarkdownV2', () => {
  it('escapes reserved chars in plain prose', () => {
    const r = renderToMarkdownV2('Hello. How are you? (a+b=c)');
    expect(r.text).toBe('Hello\\. How are you? \\(a\\+b\\=c\\)');
    expect(r.parse_mode).toBe('MarkdownV2');
  });

  it('preserves fenced code blocks and escapes ` inside', () => {
    const r = renderToMarkdownV2('Here:\n```\nfoo.bar\n```\nDone.');
    expect(r.text).toContain('```\nfoo.bar\n```');
    expect(r.text).toContain('Here:');
    expect(r.text).toContain('Done\\.');
  });

  it('preserves inline code', () => {
    const r = renderToMarkdownV2('Run `npm test` now.');
    expect(r.text).toContain('`npm test`');
    expect(r.text).toContain('now\\.');
  });

  it('converts **bold** into *bold*', () => {
    const r = renderToMarkdownV2('This is **bold** text.');
    expect(r.text).toContain('*bold*');
    expect(r.text).not.toContain('**');
  });

  it('keeps _italic_ markers intact', () => {
    const r = renderToMarkdownV2('This is _italic_ text.');
    expect(r.text).toMatch(/_italic_/);
  });

  it('renderPlain escapes everything including asterisks', () => {
    const r = renderPlain('**not bold**');
    expect(r.text).toBe('\\*\\*not bold\\*\\*');
  });
});
