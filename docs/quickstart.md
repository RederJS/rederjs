# Reder Quickstart

From zero to first live session in under 10 minutes. Two paths — pick one or do both:

- **A. Web dashboard only** — see sessions, send instructions, approve prompts from any browser.
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

## 2. Initialise

```sh
reder init --session-id mysession --display-name "My Session"
```

This creates `~/.config/reder/reder.config.yaml` (mode 0600) and `~/.config/reder/reder.env` (mode 0600).

## 3. Add your workspaces

Edit `~/.config/reder/reder.config.yaml`. Add a `workspace_dir` to each session and optionally `auto_start: true` so the daemon spawns a tmux session at boot:

```yaml
sessions:
  - session_id: mysession
    display_name: My Session
    workspace_dir: ~/code/myproject
    auto_start: true

  - session_id: notes
    display_name: Notes
    workspace_dir: ~/code/notes
    auto_start: false     # you'll start this from the dashboard or CLI
```

Enable the web adapter:

```yaml
adapters:
  web:
    module: '@rederjs/adapter-web'
    enabled: true
    config:
      bind: 127.0.0.1
      port: 7781
      auth: token
```

## 4. Register each workspace with Claude Code

Inside **every** project directory you listed above:

```sh
cd ~/code/myproject
reder install mysession

cd ~/code/notes
reder install notes
```

Each `reder install` writes a mode-0600 `.mcp.json` containing a per-session shim token. Once that file is in place, running `claude` in the directory will auto-start the shim and auto-connect to the daemon.

## 5. Start the daemon

```sh
reder start
reder status
```

`status` should print `rederd v0.1.0 — up Ns`. At this point:

- Any session with `auto_start: true` and a valid `workspace_dir` now has a tmux session running `claude` in it.
- The web dashboard is up on `127.0.0.1:7781`.

## 6A. Open the dashboard

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

## 6B. Pair Telegram

(Skip if you only want the dashboard.) Put the bot token into `~/.config/reder/reder.env`:

```
TELEGRAM_BOT_TOKEN=<your-bot-token>
```

Add the bot to `adapters.telegram.config.bots[]` in the config and `reder restart`. DM your bot from Telegram; it replies with a 6-character pair code. In the same project directory where you ran `reder install`:

```sh
reder pair <code>
```

The bot confirms pairing and you can now chat with Claude Code from Telegram.

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
reder dashboard url           # print authenticated dashboard URL
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
