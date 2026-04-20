# Phase 1 Acceptance Script

This is the manual 12-session acceptance test from the PRD. Run it before tagging v0.1.0. Record results in the release notes.

## Prerequisites

- A VPS or workstation with Node 20+ and Claude Code 2.1.81+ installed.
- 12 Telegram bot tokens, each as a distinct bot from [@BotFather](https://t.me/BotFather).
- 12 project directories (any content; simplest is `mkdir reder-sess-{1..12}`).

## Steps

### 1. Configure 12 sessions

```sh
reder init --session-id sess1 --display-name "Session 1" --bot-token "$TOK_1"
for i in 2 3 4 5 6 7 8 9 10 11 12; do
  # edit reder.config.yaml adding:
  # - session_id: sessN
  #   display_name: "Session N"
  # under sessions:
  # plus a bots: entry with token_env TELEGRAM_BOT_SESSN
  # and append TELEGRAM_BOT_SESSN=$TOK_N to reder.env
done
reder config validate
```

### 2. Start daemon

```sh
reder start
reder status
# expect: 12 sessions listed, all in state registered
```

### 3. Install shim in each project

```sh
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  (cd ~/reder-sess-$i && reder install sess$i)
done
```

### 4. Launch Claude Code in each project; pair each Telegram account

For each project:

1. `cd ~/reder-sess-$i && claude --dangerously-load-development-channels server:reder`
2. Send any DM to the bot for that session.
3. Copy the 6-char code the bot sends back.
4. In a separate terminal: `cd ~/reder-sess-$i && reder pair <code>`.
5. Confirm the bot replies "✅ Paired …".
6. Send a test message like "hello"; Claude should receive it and reply.

### 5. Permission approval via Telegram

In any session, ask Claude to run a command requiring approval, e.g. "please run `ls -la`". Claude invokes `Bash`, which triggers a permission prompt. Verify:

- The bot sends an inline-keyboard message within 2 seconds.
- Pressing `✅ Allow` results in Claude's tool call proceeding; the message edits to show "✅ Allowed".
- In another session, try `Bash` again and press `🔓 Always allow Bash`. Verify a subsequent identical command auto-allows with no prompt.

### 6. NFR-R2 chaos: kill the shim

In an active conversation in session 3:

1. Find the shim process: `pgrep -f 'reder-shim.*sess3'`.
2. `kill -9 <pid>`. Claude Code should automatically respawn the shim (if not, restart Claude Code manually).
3. Immediately send 5 Telegram messages to that session's bot.
4. Verify all 5 messages appear in Claude Code after the shim reconnects, in order, with zero loss.

### 7. NFR-R3 chaos: restart the daemon

1. `reder stop` and wait until `reder status` reports unreachable.
2. Send 3 Telegram messages to any session's bot.
3. `reder start` and watch `reder status --json | jq '.outbox'`. Verify `inbound_pending` drops to 0 within a few seconds and all 3 messages arrive in Claude Code.

### 8. Audit review

```sh
ls -la ~/.local/share/reder/audit-*.log
cat ~/.local/share/reder/audit-$(date +%Y-%m-%d).log | jq .
```

Verify:

- 12 `pair` entries.
- N `permission_verdict` entries matching what you approved.
- Each adapter start is recorded.
- No `dangerous_flag_usage` entries (unless you intentionally invoked a dangerous flag).

### 9. Clean shutdown

```sh
reder stop
# Wait for pid file to be removed. No orphan processes.
pgrep -f reder
# should print nothing
```

## Sign-off

Record:

- Pass/fail for each numbered step.
- Any anomalies in the logs.
- Time taken.

If all steps pass and no acknowledged-inbound messages were lost across steps 6 and 7, the build is ready to tag `v0.1.0` and publish to npm.
