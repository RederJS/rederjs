# Reder Quickstart

From zero to first live session in under 10 minutes. Reder talks to you through **adapters** — swappable modules for each surface (web dashboard, Telegram, …). The web adapter is enabled at install; others are opt-in via `reder <adapter> …` commands. Pick one or do both:

- **A. Web dashboard** — see sessions, send instructions, approve prompts from any browser.
- **B. Telegram** — DM Claude from your phone.

## Prerequisites

- **Node 20+** (`node --version`)
- **Claude Code 2.1.81+** (`claude --version`) — 2.1.80 works for messages but permission relay requires 2.1.81
- **tmux** on `$PATH` if you want reder to auto-start Claude Code sessions for you
- For path B: a **Telegram bot** (create one via [@BotFather](https://t.me/BotFather); copy the bot token)

## 1. Install

```sh
npm install -g reder
```

This provides three binaries: `reder` (CLI), `rederd` (daemon), `reder-shim` (MCP server).

## 2. Initialise the daemon

```sh
reder init
```

An interactive wizard prompts for:

- **Bind address** for the web dashboard (defaults to `127.0.0.1`; auto-detects your Tailscale IPv4 if `tailscale` is on `$PATH` and offers it as an option).
- **Port** for the web dashboard (defaults to `7781`).

This creates `~/.config/reder/reder.config.yaml` (mode 0600) and `~/.config/reder/reder.env` (mode 0600) with the web adapter enabled. Re-run `reder init` any time to change bind/port — it preserves your sessions and other settings.

For scripted setups: `reder init --bind 127.0.0.1 --port 7781` skips the prompts.

## 3. Register each project as a session

Inside **every** project directory you want reder to manage:

```sh
cd ~/code/myproject
reder sessions add
```

An interactive wizard prompts for:

- **Session id** (defaults to the sanitized folder name)
- **Display name** (defaults to a prettified version of the session id)
- **Auto-start** — set to yes and the daemon will launch a tmux `claude` session here on boot

Non-interactive form: `reder sessions add mysession --display-name "My Session" --auto-start`.

`reder sessions add` writes three things:

1. A `.mcp.json` in the project directory (mode 0600) with a fresh per-session shim token.
2. An entry in `~/.config/reder/reder.config.yaml`'s `sessions:` list with `workspace_dir` set to the current directory.
3. A row in the SQLite session database.

To remove a session later, run `reder sessions remove <session-id>` — it cleans up all three surfaces.

## 5. Start the daemon

```sh
reder start
reder status
```

`status` should print `rederd v0.1.0 — up Ns`. At this point:

- Any session with `auto_start: true` and a valid `workspace_dir` now has a tmux session running `claude` in it.
- The web dashboard is up on `127.0.0.1:7781`.

## 6A. Web adapter — open the dashboard

```sh
reder dashboard url
```

Prints something like:

```
Dashboard: http://127.0.0.1:7781/?token=rdr_web_abc…
Token file: /home/you/.local/share/reder/dashboard.token
```

Paste that URL into a browser. The `?token=` query sets a cookie; subsequent visits just need the bare URL. You'll see one card per configured session. Click any session to:

- Read the transcript (inbound + Claude's replies, newest at bottom).
- Type instructions in the input box (Enter to send).
- Approve/deny tool permission prompts when Claude asks.

A session without `auto_start` shows a **Start** button — clicking it spawns the tmux session on demand (same as `reder sessions start <id>`).

## 6B. Telegram adapter — attach a bot per session

(Skip if you only want the dashboard.) Each session gets its **own** bot, so DMs to a given bot route to one Claude Code session. Create one bot per session via [@BotFather](https://t.me/BotFather), then attach it:

```sh
reder telegram bot add <session-id>       # prompts for the token (masked)
# or non-interactive:
reder telegram bot add <session-id> --token 123456:ABC-DEF…
```

This writes the bot inline into `~/.config/reder/reder.config.yaml` (mode 0600). Then `reder restart`.

### Access control: pairing vs. allowlist

Two modes, globally configured:

- **`pairing` (default)** — first DM from an unknown Telegram account triggers a 6-character pair code. In the project directory: `reder pair <code>`. The bot confirms and future DMs route through.
- **`allowlist`** — only Telegram numeric user_ids on the global list can DM any bot; unknown senders are silently dropped, no pair code. Use for a locked-down setup.

```sh
reder telegram mode                       # show current mode
reder telegram mode allowlist             # switch
reder telegram allow add 123456789        # numeric Telegram user_id
reder telegram allow list
```

(Find your user_id by DMing [@userinfobot](https://t.me/userinfobot), or by reading the pair-code DM — it names the sender.)

### Other Telegram commands

```sh
reder telegram bot list                   # which sessions have bots
reder telegram bot remove <session-id>    # drop a session's bot
reder telegram allow remove <user-id>
```

To use an externally-managed secret (systemd drop-in, secret manager) instead of inline: `reder telegram bot add <session> --token-env MY_VAR`. Reder will resolve `${env:MY_VAR}` at daemon start.

## What to expect

- Inbound messages from any adapter appear to Claude as MCP channel events in its context.
- Claude replies via its `reply` tool. Each adapter translates those replies to its own transport (Telegram message, dashboard SSE push, etc.).
- When Claude wants to run a tool that needs approval (Bash, Write, Edit, …), every connected adapter gets a prompt: Telegram shows inline buttons, the dashboard shows a banner. The first Allow/Deny wins.
- Messages sent while the shim or Claude Code is restarting are queued and delivered on reconnect. No message loss.

## Day-to-day CLI

```sh
reder sessions list           # configured sessions + tmux status
reder sessions start <id>     # start a tmux session on demand
reder sessions up             # start everything with a workspace_dir (idempotent)
reder dashboard url           # (web adapter) print authenticated dashboard URL
reder telegram bot list       # (telegram adapter) configured bots
reder telegram allow list     # (telegram adapter) global allowlist
reder telegram mode           # (telegram adapter) current access mode
reder status                  # daemon health snapshot
reder doctor                  # diagnostic checks with remediation
```

## Troubleshooting

- **`reder doctor`** runs every safety check (Node version, config parse, daemon reachable, env vars present, third-party adapter flagged). Every failing check includes a remediation.
- **Dashboard won't load**: confirm the daemon is running (`reder status`) and you're using the exact URL from `reder dashboard url`. Bare `http://127.0.0.1:7781/` without a cookie returns 401 until the token has been presented once.
- **Session shows `tmux: off` in dashboard**: the tmux session for that `session_id` isn't running. Click **Start** or `reder sessions start <id>`.
- **Logs**: on systemd-user hosts, `journalctl --user -fu reder`. Otherwise, tail the output of `rederd`.
- **`reder status --json`** dumps the full daemon health JSON for piping into other tools.

## Next steps

- Expose the dashboard over Tailscale with Caddy — see [README.md](../README.md#running-behind-caddy--tailscale).
- Security review: [security.md](security.md).
- Community adapters: [adapter-authoring.md](adapter-authoring.md).

## Known limitations in v0.1

- Voice notes (Telegram) are rejected with a "not yet supported" reply. Send text or paste a transcript.
- Interrupts from Telegram (`/interrupt`) are not wired yet — you can cancel from the terminal.
- The dashboard transcript shows adapter-level messages (what Telegram would see). Claude's own tool use / thinking isn't mirrored — that's on the roadmap.
- Upgrade-via-migrations not shipped yet; upgrade by stopping the daemon, running `npm install -g reder@latest`, and restarting.
- No Twilio voice (Phase 2).
