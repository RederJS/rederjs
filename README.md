# Reder

**Remote-control your Claude Code sessions from anywhere** — Telegram, a browser dashboard, or whatever you plug into it next.

Reder is a daemon that sits next to `claude` and bridges it to the outside world. It runs on your workstation or home server, watches your tmux-hosted Claude Code sessions, and exposes them through pluggable adapters:

- **Web dashboard** — one page per session, live transcript, send instructions from any browser on your LAN or Tailnet.
- **Telegram bot** — DM Claude, get replies, approve permission prompts from your phone.
- **Your own adapter** — Slack, IRC, SMS, email. The adapter interface is 4 methods.

```
 ┌───────────┐      ┌─────────────┐      ┌─────────────────┐
 │  Browser  │ ◀──▶ │             │ ◀──▶ │  claude (tmux)  │
 ├───────────┤      │   rederd    │      │                 │
 │  Telegram │ ◀──▶ │   daemon    │ ◀──▶ │  claude (tmux)  │
 ├───────────┤      │             │      │                 │
 │ Your next │ ◀──▶ │             │ ◀──▶ │  claude (tmux)  │
 │  adapter  │      └─────────────┘      └─────────────────┘
 └───────────┘
```

## Status

`0.1` — usable on a single host. Web dashboard, Telegram adapter, tmux session management, permission relay, persistent approvals. Not yet: multi-host, voice, Slack.

---

## Requirements

- **Node 20+** (`node --version`)
- **Claude Code 2.1.81+** (`claude --version`)
- **tmux** (for auto-started sessions — not needed if you launch `claude` yourself)
- **A Telegram bot** (optional, only if you want that adapter — create via [@BotFather](https://t.me/BotFather))

## Install

```sh
npm install -g rederjs
```

Provides three binaries:

| Binary       | Role                                                                |
| ------------ | ------------------------------------------------------------------- |
| `reder`      | CLI — init, sessions add/remove/repair/restart, start/stop, status, dashboard, etc. |
| `rederd`     | Long-running daemon                                                 |
| `reder-shim` | MCP server Claude Code loads in each project                        |

---

## Quickstart (web dashboard only)

```sh
# 1. Configure the daemon (prompts for bind + port; auto-detects Tailscale)
reder init

# 2. Register each project as a session
cd ~/code/myproject
reder sessions add --auto-start
# (prompts for session id, display name, auto-start — defaults from folder name)

# 3. Open the dashboard
reder dashboard url
# → http://127.0.0.1:7781/?token=rdr_web_…
```

Paste that URL into a browser. The `?token=` sets a cookie; subsequent visits just need `http://127.0.0.1:7781/`.

Run `reder sessions add` inside each project directory you want reder to know about. It writes a `.mcp.json` so Claude Code loads the shim and auto-connects to the daemon when you run `claude` there, and it adds the session to `reder.config.yaml` with `workspace_dir` set to that directory.

---

## Quickstart (Telegram)

After step 2 above, also set `TELEGRAM_BOT_TOKEN` in `~/.config/reder/reder.env`:

```sh
echo 'TELEGRAM_BOT_TOKEN=<your-bot-token>' >> ~/.config/reder/reder.env
chmod 600 ~/.config/reder/reder.env
reder restart
```

Then DM your bot from Telegram. It'll reply with a pair code. Run:

```sh
reder pair <code>
```

…inside any project where you've run `reder sessions add`. Done.

See [docs/quickstart.md](docs/quickstart.md) for the full walkthrough.

---

## Configuration

Everything lives in `~/.config/reder/reder.config.yaml`. A working example:

```yaml
version: 1

runtime:
  runtime_dir: ~/.local/share/reder
  data_dir: ~/.local/share/reder/data

logging:
  level: info

sessions:
  - session_id: reder
    display_name: Reder
    workspace_dir: ~/development/reder
    auto_start: true

  - session_id: caddy
    display_name: Caddy
    workspace_dir: ~/development/caddy
    auto_start: true

  - session_id: ad-hoc
    display_name: Ad-hoc Session
    # no workspace_dir → reder won't auto-start a tmux session for this one

adapters:
  web:
    module: '@rederjs/adapter-web'
    enabled: true
    config:
      bind: 127.0.0.1
      port: 7781
      auth: token              # 'token' (default) or 'none'
      # host_allowlist: []     # extra Host headers to accept beyond loopback

  telegram:
    module: '@rederjs/adapter-telegram'
    enabled: true
    config:
      bots:
        - session_id: reder
          token: ${env:TELEGRAM_BOT_TOKEN}
```

### Session fields

| Field           | Required | Meaning                                                                    |
| --------------- | -------- | -------------------------------------------------------------------------- |
| `session_id`    | yes      | Stable identifier — also the tmux session name. `[a-z0-9_-]{2,63}`         |
| `display_name`  | yes      | Human label shown in dashboard and Telegram pairing messages               |
| `workspace_dir` | no       | Directory `claude` should run in. Required for tmux auto-start or CLI start |
| `avatar`        | no       | Path to a PNG/JPEG/WebP/GIF shown on the dashboard. Resolved relative to the config file; absolute paths honored. Falls back to initials if absent or unreadable. |
| `auto_start`    | no       | `true` → daemon starts a tmux session at boot if one isn't already running |

When `auto_start: true`, on daemon start reder runs the equivalent of:

```sh
tmux new-session -d -s <session_id> -c <workspace_dir> \
  'claude --dangerously-load-development-channels server:reder'
```

(if no tmux session by that name exists). Each workspace needs `.mcp.json` in place — put it there once with `reder sessions add` run from inside the project directory.

**Requirements for auto-start to actually work:**

- The `claude` binary must be on the daemon's `PATH`. `reder init` generates a systemd user unit that prepends `$HOME/.local/bin` and `$HOME/bin` to the PATH so the Claude Code CLI (installed at `~/.local/bin/claude` by default) is reachable. If you install Claude elsewhere, ensure it's on one of those dirs or edit the unit's `Environment=PATH=…` line.
- Claude Code 2.1.118+ shows a one-time confirmation dialog for `--dangerously-load-development-channels` on every new session. Reder auto-presses Enter on the dialog ~6s after tmux spawn so daemon-auto-started sessions don't sit at it forever.
- If a tmux session already exists with the session's name but its pane is no longer running `claude` (e.g. you exited out to a shell), auto-start will **skip** it and the daemon logs a warning naming `reder sessions restart <id>` as remediation. This is deliberate — reder never auto-kills a tmux where you might be working.

### Web adapter security

The web adapter is safe-by-default:

- **Loopback-bound**. Don't expose `127.0.0.1:7781` to the internet. If you want remote access, front it with Caddy/nginx + Tailscale/WireGuard.
- **Token auth on by default**. A 32-byte random token is generated on first start at `<data_dir>/dashboard.token` (0600). Obtain the authenticated URL with `reder dashboard url`.
- **Host allowlist**. Only the configured `bind` address plus loopback names are accepted on the `Host:` header. Others get HTTP 421. Cheap defense against DNS rebinding.
- **Same-origin enforcement** on state-changing verbs.
- Set `auth: none` to disable the token requirement when you have a trusted reverse proxy handling auth.

Full threat model in [docs/security.md](docs/security.md).

---

## The CLI

```sh
reder init                        # configure daemon (bind, port); re-runnable
reder start / stop / restart      # manage the daemon
reder status                      # query the daemon over HTTP
reder doctor                      # run diagnostic checks
reder pair <code>                 # redeem a 6-char Telegram pair code
reder config validate             # lint config YAML

reder sessions add [id]           # register a session (writes .mcp.json + .claude/settings.local.json)
reder sessions remove <id>        # remove a session (YAML, DB, .mcp.json, hook entries)
reder sessions list               # configured sessions + tmux status
reder sessions start <id>         # start a tmux session now
reder sessions restart <id>       # kill stale tmux + re-start (recovers panes where claude exited)
reder sessions repair <id>        # rewrite .mcp.json and .claude/settings.local.json (use on `unknown` status)
reder sessions up                 # start every session with a workspace_dir

reder dashboard url               # print the authenticated dashboard URL
```

---

## What the dashboard shows

**Session list** — one card per configured session:

- Display name + workspace path
- Status pill: **working** (Claude is actively processing) / **needs you** (Claude is awaiting your reply or a permission) / **idle** / **unknown** / **offline**. Powered by Claude Code hooks that reder installs per session.
- Connection dots: **shim** (is a Claude Code process connected?) and **tmux** (is a tmux session by that name running?)
- Unread-message badge (messages received from other adapters since you last opened the session)
- "Start" button when tmux isn't running and the session has a `workspace_dir`
- Last message timestamp

**Session detail** — click any session:

- Merged inbound/outbound transcript, newest at the bottom, auto-scroll on new messages
- Input box to send instructions (Enter to send, Shift+Enter for newline)
- Permission banner at top when Claude requests approval — click Allow/Deny, decision round-trips to Claude
- Live updates over Server-Sent Events; no polling, no refresh

Messages you send from the dashboard flow through the same router as Telegram, land in the same SQLite tables, and appear to Claude as ordinary MCP channel events.

---

## Running behind Caddy + Tailscale

Typical personal setup — Caddy exposes reder to your Tailnet with TLS, no external DNS:

```Caddyfile
reder.your-tailnet.ts.net {
    reverse_proxy 127.0.0.1:7781
}
```

Add `reder.your-tailnet.ts.net` to `adapters.web.config.host_allowlist` so the Host-header check passes.

Token auth continues to work end-to-end over the proxy. If you'd rather let Caddy handle auth (e.g. Authelia, mTLS, basic auth), set `adapters.web.config.auth: none`.

---

## Architecture in 90 seconds

- **`rederd`** — long-running daemon. Owns:
  - A Unix socket (`~/.local/share/reder/rederd.sock`) — shim connections from each Claude Code process.
  - SQLite at `~/.local/share/reder/data/reder.db` — sessions, messages, bindings, permission requests.
  - An HTTP server (from the web adapter when enabled) — `/health` + `/api/*`.
  - Adapters loaded dynamically from config.

- **`reder-shim`** — an MCP server launched by Claude Code via `.mcp.json`. Authenticates with an argon2id-hashed session token, then proxies channel events and `reply` tool calls to/from the daemon.

- **Adapters** — implement a 4-method `Adapter` interface (`start`, `stop`, `sendOutbound`, `sendPermissionPrompt`). The router handles queueing, retry, and recipient resolution; adapters only translate to their own transport.

Write your own: [docs/adapter-authoring.md](docs/adapter-authoring.md).

---

## Docs

- [Quickstart](docs/quickstart.md) — from zero to first message
- [Development](docs/development.md) — local dev setup and iteration loop
- [Security model](docs/security.md) — threat model, controls, operator checklist
- [Adapter authoring](docs/adapter-authoring.md) — build your own adapter
- [Acceptance criteria](docs/acceptance.md) — what v0.1 does and doesn't promise
- [Product requirements (PRD)](docs/reder-prd.md) — design rationale

---

## Development

```sh
git clone https://github.com/…/reder
cd reder
npm install
npm run build
npm test
```

The workspace layout:

```
packages/
  core/              # shared: router, IPC, storage, tmux, sessions
  daemon/            # rederd entry point + bootstrap
  shim/              # MCP server that each Claude Code process loads
  cli/               # the `reder` command
  adapter-telegram/  # Telegram bot
  adapter-web/       # Dashboard (Express + SSE + React SPA)
```

For the full local dev loop — linking the workspace bins onto your `PATH`, TS watch mode, dashboard HMR, running the Telegram adapter against a dev bot — see [docs/development.md](docs/development.md).

---

## Status & roadmap

- ✅ v0.1 — Telegram, web dashboard, tmux auto-start, permission relay, persistent approvals, per-sender rate limit, audit log
- 🔜 Slack / Matrix adapters
- 🔜 Full Claude Code terminal mirroring via `tmux pipe-pane`
- 🔜 Upgrade-safe migrations
- 🔜 Voice (Twilio)

## Reporting issues

Open a regular issue for bugs and feature requests. For security problems, open a private advisory on GitHub — do not file a public issue.

## License

MIT.
