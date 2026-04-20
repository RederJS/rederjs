# Reder Quickstart

From zero to first Telegram message in under 10 minutes.

## Prerequisites

- **Node 20+** (`node --version`)
- **Claude Code 2.1.81+** (`claude --version`) — 2.1.80 works for messages but permission relay requires 2.1.81
- A **Telegram bot** (create one via [@BotFather](https://t.me/BotFather); copy the bot token)

## 1. Install

```sh
npm install -g reder
```

This provides three binaries: `reder` (CLI), `rederd` (daemon), `reder-shim` (MCP server).

## 2. Initialise

```sh
reder init --session-id mysession --display-name "My Session" --bot-token "$TELEGRAM_BOT_TOKEN"
```

This creates `~/.config/reder/reder.config.yaml` (mode 0600) and `~/.config/reder/reder.env` (mode 0600), both with sensible defaults for a single-session setup.

## 3. Start the daemon

```sh
reder start
reder status
```

`status` should print `rederd v0.1.0 — up Ns`. If not, `reder doctor` will tell you why.

## 4. Register your project with Claude Code

From the project directory where you want to run Claude Code:

```sh
reder install mysession
```

This writes a `.mcp.json` file (mode 0600) containing a per-session shim token.

## 5. Launch Claude Code with the channel flag

Claude Code 2.1.81 still requires the `--dangerously-load-development-channels` flag for third-party channel plugins (this will change once Reder is in the official marketplace):

```sh
claude --dangerously-load-development-channels server:reder
```

## 6. Pair your Telegram account

Send any message to your bot on Telegram. The bot will reply with a 6-character pair code and instructions. In the same project directory where you launched Claude Code, run:

```sh
reder pair <code>
```

The bot will confirm pairing and you can now chat with Claude Code from Telegram.

## What to expect

- Inbound Telegram messages appear in Claude Code as channel events (displayed in Claude's context).
- Claude replies via its `reply` tool — the bot posts them back as Telegram messages.
- When Claude wants to run a tool that needs approval (Bash, Write, Edit, …), the bot sends you an inline-keyboard message with Allow / Deny / "Always allow this tool" buttons.
- Messages sent while the shim or Claude Code is restarting are queued and delivered on reconnect. No message loss.

## Troubleshooting

- **`reder doctor`** runs every safety check (Node version, config parse, daemon reachable, env vars present, third-party adapter flagged). Every failing check includes a remediation.
- **Logs**: on systemd-user hosts, `journalctl --user -fu reder`. Otherwise, tail the output of `rederd`.
- **`reder status --json`** dumps the full daemon health JSON for piping into other tools.

## Next steps

- Multi-session: edit `reder.config.yaml`, add entries under `sessions:` and `adapters.telegram.config.bots:`, then `reder restart` and `reder install <newsession>` in each new project.
- Security: review [security.md](security.md) before exposing a bot to anyone outside your immediate trust.
- Community adapters: [adapter-authoring.md](adapter-authoring.md).

## Known limitations in v0.1

- Voice notes are rejected with a "not yet supported" reply. Send text or paste a transcript.
- Interrupts from Telegram (`/interrupt`) are not wired yet — you can cancel from the terminal.
- Upgrade-via-migrations not shipped yet; upgrade by stopping the daemon, running `npm install -g reder@latest`, and restarting.
- No Twilio voice (Phase 2).
