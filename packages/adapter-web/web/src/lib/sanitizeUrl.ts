// URL scheme allowlist for the dashboard Markdown renderer.
//
// Messages flowing into the web dashboard can originate from untrusted
// adapters (Telegram, anything POSTing to /api/sessions/:id/messages), so
// link hrefs in user content must be treated as untrusted input. React does
// not sanitize the `href` attribute — a `javascript:alert(1)` or
// `data:text/html,...` URL clicked in the dashboard would execute script in
// the dashboard's origin.
//
// `safeHref` returns the original href when it is safe to render as an
// anchor, and `null` when the caller should render the link's label as
// plain text instead.
//
// Allowed:
//   - http: and https: absolute URLs
//   - mailto: addresses
//   - relative paths ("/foo", "foo/bar", "./foo")
//   - same-page anchors ("#section")
//   - protocol-relative ("//example.com/foo")
//
// Disallowed:
//   - any other scheme (javascript:, data:, vbscript:, file:, custom, ...)
//   - empty / whitespace-only hrefs
//
// We rely on the WHATWG `URL` parser rather than regex sniffing so that
// scheme detection is robust against whitespace, embedded control
// characters, and other tricks browsers are lenient about
// (e.g. `\tjavascript:alert(1)` or `java\tscript:`).

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function safeHref(href: string | undefined | null): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;

  // Same-page anchor.
  if (trimmed.startsWith('#')) return trimmed;

  // Protocol-relative URL ("//example.com/foo"). The URL parser treats this
  // as absolute against any base, so we just need to confirm it isn't a
  // path that happens to start with two slashes after weird whitespace.
  if (trimmed.startsWith('//')) return trimmed;

  // Relative path: starts with "/" (single slash), "./", or "../", or has
  // no scheme-like prefix at all.
  let parsed: URL;
  try {
    // Parse against a synthetic base. Relative inputs inherit the base's
    // `http:` scheme (acceptable — we return the original string anyway);
    // absolute inputs surface their own `protocol`.
    parsed = new URL(trimmed, 'http://_invalid_base_/');
  } catch {
    return null;
  }

  // Detect whether the input was itself absolute. If parsing the same
  // input WITHOUT a base also succeeds, it had its own scheme; if it
  // throws, the input is relative and inherited the base's scheme.
  let hadOwnScheme = false;
  try {
    void new URL(trimmed);
    hadOwnScheme = true;
  } catch {
    hadOwnScheme = false;
  }

  if (!hadOwnScheme) {
    // Relative path / anchor / protocol-relative — already filtered above
    // for anchor and protocol-relative cases; remaining relatives are safe
    // to pass through verbatim.
    return trimmed;
  }

  if (ALLOWED_SCHEMES.has(parsed.protocol.toLowerCase())) {
    return trimmed;
  }

  return null;
}
