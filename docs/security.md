# Reder Security Model

## Threat model (v0.1)

Adversaries Reder defends against:

1. **Network attackers** reaching exposed endpoints. The Telegram adapter is outbound-only long-poll. The web dashboard binds to loopback by default, gates `/api/*` behind a token, and enforces a Host-header allowlist. If you expose it beyond loopback, you do so through a reverse proxy (Caddy/Tailscale) you already trust.
2. **Other local users or processes** reaching `127.0.0.1:7781`. On a shared machine or laptop, any browser tab, CLI, or postinstall script can reach loopback ports. Token auth, same-origin enforcement on state-changing verbs, and Host allowlist defend against that path.
3. **Unauthorised Telegram users** who discover a bot. Every message is filtered through a deny-by-default pairing table.
4. **Malicious third-party adapters** the operator installs from npm. Adapters run in-process (no sandbox in v0.1), so installation is trust; `reder doctor` flags non-`@rederjs/*` modules loudly.
5. **Local users on a shared machine** attempting to read secrets or inject IPC events. The IPC socket is mode 0600 in a 0700 directory; `reder.env`, `.mcp.json`, and `dashboard.token` are mode 0600.
6. **A compromised upstream service** (Telegram, OpenAI, …) attempting to pivot into the Reder host. STT-transcribed text is never interpreted as a command; the only privileged IPC path is the per-session argon2id-hashed shim token.

Out of scope for v0.1:

- An attacker with root on the host (they already own the session).
- A compromised `claude.ai` account (they can already do everything the user can).
- Side-channel timing attacks.

## Controls

| # | Control | Where |
| --- | --- | --- |
| S1 | No inbound public ports by default | Telegram adapter uses long-poll; web + health bind to 127.0.0.1 |
| S2 | Sender allowlist deny-by-default (pairing mode) or explicit global allowlist (allowlist mode) | `adapter-telegram/src/index.ts` gates via `bindings` table or `config.allowlist` |
| S3 | Per-session shim tokens (argon2id-hashed) | `core/src/sessions.ts` |
| S4 | Permission timeout defaults to deny | `core/src/permissions.ts` |
| S5 | Web dashboard token auth (32-byte random, 0600 file) | `adapter-web/src/auth.ts` |
| S6 | Web dashboard Host-header allowlist (defeats DNS rebinding) | `adapter-web/src/auth.ts` |
| S7 | Web dashboard same-origin enforcement on state-changing verbs | `adapter-web/src/auth.ts` |
| S8 | Config and env files mode 0600; secrets may be inline in `reder.config.yaml` or referenced via `${env:}` / `${file:}` | `core/src/config.ts` |
| S9 | Third-party adapter startup warning | `daemon/src/adapter-host.ts` |
| S10 | Transcribed/inbound text never interpreted as a command | N/A — never parsed as code |
| S11 | Per-sender rate limiting (60/min default) | `adapter-telegram/src/index.ts` |
| S12 | Audit log at `${runtime_dir}/audit-YYYY-MM-DD.log` mode 0600 | `core/src/audit.ts` |
| S13 | `npm audit --omit=dev --audit-level=high` in CI | `.github/workflows/ci.yml` |
| S14 | No `eval` / dynamic codegen (enforced by lint) | `eslint.config.js` |

## Operator checklist before exposing a Telegram bot

1. Attach the bot via `reder telegram bot add <session-id>` — the token lands inline in `~/.config/reder/reder.config.yaml` (mode 0600). If you prefer an externally-managed secret, use `--token-env MY_VAR` and set `MY_VAR` via a systemd drop-in or secret manager; `reder.env` is also read at daemon start.
2. Decide on access mode: `reder telegram mode allowlist` + `reder telegram allow add <user-id>` for a locked-down setup, or the default `pairing` for deny-by-default with per-account pair codes. `reder telegram mode` and `reder telegram allow list` show current state.
3. Run `reder doctor`; confirm all checks pass and no third-party adapters are flagged unexpectedly.
4. In pairing mode, before running `reder pair <code>` locally, verify the code matches what the bot DM showed — the code is the binding proof.
5. Monitor the audit log: `tail -f ~/.local/share/reder/audit-*.log`.
6. Rotate the shim token if you suspect `.mcp.json` was exfiltrated: rerun `reder sessions add <session>` inside the project directory.

## Operator checklist before exposing the dashboard

1. Don't bind the web adapter to `0.0.0.0` — keep it on `127.0.0.1` and front it with a reverse proxy (Caddy, nginx) on a private network (Tailscale, WireGuard, home LAN).
2. Add the public hostname you proxy through to `adapters.web.config.host_allowlist` so the Host-header check passes.
3. Keep `auth: token` on unless your reverse proxy provides equivalent auth (Authelia, mTLS, SSO). `auth: none` trusts everything upstream.
4. The dashboard token lives at `<data_dir>/dashboard.token` (mode 0600). Rotate it by deleting the file and restarting the daemon; a new token is generated automatically.
5. If you share the URL with someone, share only the bare `http://host:port/` — not the `?token=…` form. The token is long-lived credential material.
6. The dashboard accepts the token as a cookie, `Authorization: Bearer`, or one-time `?token=` query. Query-string presentation leaves the token in browser history and reverse-proxy access logs — treat it as a handoff, not a persistent auth mechanism.

## Reporting security issues

Open a private security advisory on the Reder GitHub repository. Please do not file public issues for security problems.
