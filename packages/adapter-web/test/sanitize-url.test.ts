import { describe, it, expect } from 'vitest';
import { safeHref } from '../web/src/lib/sanitizeUrl';

describe('safeHref — allowed schemes', () => {
  it('passes through http:// URLs', () => {
    expect(safeHref('http://example.com')).toBe('http://example.com');
  });

  it('passes through https:// URLs', () => {
    expect(safeHref('https://example.com/path?q=1#frag')).toBe('https://example.com/path?q=1#frag');
  });

  it('passes through mailto: URLs', () => {
    expect(safeHref('mailto:foo@example.com')).toBe('mailto:foo@example.com');
  });

  it('accepts uppercase HTTPS (case-insensitive scheme match)', () => {
    expect(safeHref('HTTPS://example.com')).toBe('HTTPS://example.com');
  });
});

describe('safeHref — relative and anchor URLs', () => {
  it('passes through absolute paths', () => {
    expect(safeHref('/relative/path')).toBe('/relative/path');
  });

  it('passes through bare relative paths', () => {
    expect(safeHref('foo/bar')).toBe('foo/bar');
  });

  it('passes through ./relative paths', () => {
    expect(safeHref('./foo')).toBe('./foo');
  });

  it('passes through ../parent paths', () => {
    expect(safeHref('../foo')).toBe('../foo');
  });

  it('passes through same-page anchors', () => {
    expect(safeHref('#section')).toBe('#section');
  });

  it('passes through protocol-relative URLs', () => {
    expect(safeHref('//example.com/foo')).toBe('//example.com/foo');
  });
});

describe('safeHref — XSS payloads (rejected)', () => {
  it('rejects javascript: URLs', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
  });

  it('rejects uppercase JAVASCRIPT: URLs', () => {
    expect(safeHref('JAVASCRIPT:alert(1)')).toBeNull();
  });

  it('rejects mixed-case JavaScript: URLs', () => {
    expect(safeHref('JaVaScRiPt:alert(1)')).toBeNull();
  });

  it('rejects javascript: with leading whitespace', () => {
    expect(safeHref('\tjavascript:alert(1)')).toBeNull();
    expect(safeHref(' javascript:alert(1)')).toBeNull();
    expect(safeHref('\njavascript:alert(1)')).toBeNull();
  });

  it('rejects javascript: with embedded tab inside the scheme', () => {
    // The WHATWG URL parser strips tabs/newlines from the input before
    // parsing, so `java\tscript:` normalizes to `javascript:` — exactly the
    // attack we need to catch. (Browsers do the same when resolving href.)
    expect(safeHref('java\tscript:alert(1)')).toBeNull();
    expect(safeHref('java\nscript:alert(1)')).toBeNull();
  });

  it('rejects data: URLs', () => {
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHref('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
  });

  it('rejects vbscript: URLs', () => {
    expect(safeHref('vbscript:msgbox(1)')).toBeNull();
  });

  it('rejects file: URLs', () => {
    expect(safeHref('file:///etc/passwd')).toBeNull();
  });

  it('rejects custom/unknown schemes', () => {
    expect(safeHref('myapp://do-something')).toBeNull();
    expect(safeHref('ftp://example.com')).toBeNull();
    expect(safeHref('ws://example.com')).toBeNull();
  });
});

describe('safeHref — empty / invalid input', () => {
  it('rejects empty string', () => {
    expect(safeHref('')).toBeNull();
  });

  it('rejects whitespace-only string', () => {
    expect(safeHref('   ')).toBeNull();
    expect(safeHref('\t\n')).toBeNull();
  });

  it('rejects null and undefined', () => {
    expect(safeHref(null)).toBeNull();
    expect(safeHref(undefined)).toBeNull();
  });
});
