# Reder Security Model

## Threat model (v0.1)

Adversaries Reder defends against:

1. **Network attackers** reaching exposed endpoints. Reder v0.1 exposes no inbound public ports; Telegram is outbound-only long-poll, and the health endpoint binds to loopback.
2. **Unauthorised Telegram users** who discover a bot. Every message is filtered through a deny-by-default pairing table.
3. **Malicious third-party adapters** the operator installs from npm. Adapters run in-process (no sandbox in v0.1), so installation is trust; `reder doctor` flags non-`@reder/*` modules loudly.
4. **Local users on a shared machine** attempting to read secrets or inject IPC events. The IPC socket is mode 0600 in a 0700 directory; `reder.env` and `.mcp.json` are mode 0600.
5. **A compromised upstream service** (Telegram, OpenAI, …) attempting to pivot into the Reder host. STT-transcribed text is never interpreted as a command; the only privileged IPC path is the per-session argon2id-hashed shim token.

Out of scope for v0.1:

- An attacker with root on the host (they already own the session).
- A compromised `claude.ai` account (they can already do everything the user can).
- Side-channel timing attacks.

## Controls

| # | Control | Where |
| --- | --- | --- |
| S1 | No inbound public ports | Telegram adapter uses long-poll; health on 127.0.0.1 only |
| S2 | Sender allowlist deny-by-default | `adapter-telegram/src/index.ts` gates via `bindings` table |
| S3 | Per-session shim tokens (argon2id-hashed) | `core/src/sessions.ts` |
| S4 | Permission timeout defaults to deny | `core/src/permissions.ts` |
| S8 | Secrets via `${env:}` / `${file:}`; `.env` mode 0600 | `core/src/config.ts` |
| S9 | Third-party adapter startup warning | `daemon/src/adapter-host.ts` |
| S10 | Transcribed/inbound text never interpreted as a command | N/A — never parsed as code |
| S11 | Per-sender rate limiting (60/min default) | `adapter-telegram/src/index.ts` |
| S12 | Audit log at `${runtime_dir}/audit-YYYY-MM-DD.log` mode 0600 | `core/src/audit.ts` |
| S13 | `npm audit --omit=dev --audit-level=high` in CI | `.github/workflows/ci.yml` |
| S14 | No `eval` / dynamic codegen (enforced by lint) | `eslint.config.js` |

## Operator checklist before exposing a bot

1. Store the bot token in `reder.env` only; never in the config YAML.
2. Run `reder doctor`; confirm all checks pass and no third-party adapters are flagged unexpectedly.
3. Before pairing your Telegram account, verify the code on the bot matches what you saw.
4. Monitor the audit log: `tail -f ~/.local/share/reder/audit-*.log`.
5. Rotate the shim token if you suspect `.mcp.json` was exfiltrated: rerun `reder install <session>`.

## Reporting security issues

Open a private security advisory on the Reder GitHub repository. Please do not file public issues for security problems.
