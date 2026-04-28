# Reder

**Project Requirements & Architecture Document**

*A durable, pluggable channel adapter for Claude Code. Built on the official Channels protocol.*

> In 17th-century Dutch maritime commerce, a **reder** was the owner-operator of a fleet of ships — the person who commissioned voyages, equipped the vessels, and directed the captains. Not the captain of one ship. The commander of many. This tool is that, for your AI coding agents.

---

## 1. Executive Summary

Reder is a Claude Code channel adapter that lets you remotely control a running Claude Code session from Telegram (Phase 1) and a phone call (Phase 2), with the resilience characteristics that distinguish it from every existing community option: messages never drop while the session is alive, reconnections are invisible to the user, and permission approvals happen remotely.

It is built on Anthropic's official Channels MCP protocol — not on tmux scraping, not on Claude Code hooks — so it inherits whatever future capabilities Anthropic ships for the protocol, and it operates on the same security rails the official Telegram and Discord plugins use.

Reder is plugin-based. The core ships Telegram and Twilio Voice adapters; third parties can ship Slack, Discord-extended, WhatsApp, SMS, or anything else without touching the core.

There is no GUI. Installation, configuration, operation, and upgrade all happen via a single CLI.

---

## 2. Problem Statement

### 2.1 Who this is for

Developers who:

- Run one or more long-lived Claude Code sessions on a VPS, remote workstation, or personal machine
- Subscribe to Claude Pro or Max and want to use their subscription (not API keys)
- Want to monitor and control sessions from their phone without being at a keyboard
- Need resilience: the channel stays alive if the network blips, the adapter crashes, or the upstream connection drops

### 2.2 What currently disappoints them

- **Official Telegram plugin**: one bot per session, no message queue — offline messages vanish. Permission prompts were terminal-blocking until v2.1.81 and remain awkward.
- **Claude Code Remote Control**: sessions drop silently and are not recoverable without user intervention.
- **tmux-scraping bridges (ccgram, ccbot, ccc)**: work well but sit outside the official protocol, so they won't inherit future Anthropic improvements (better permission relay UX, richer structured events, cross-session primitives). They also cannot use the same permission-relay mechanism as official plugins.
- **No unified voice+text adapter exists**. Live phone conversations with a running session is net-new territory.
- **OpenClaw-style systems** wrap the Claude Code SDK, run outside the official auth path, and are not officially supported.

### 2.3 What Reder delivers

- Telegram two-way messaging with permission relay, built on the official channel protocol
- Live phone calls to the same session via Twilio Media Streams, with speech-to-text inbound and text-to-speech outbound
- A durability layer that survives network drops, MCP subprocess crashes, and adapter restarts without losing a single message
- Pluggable adapter interface so the community can ship their own transports
- Zero-UI, CLI-first operation with clear logs and a single config file

### 2.4 What Reder explicitly does not do

- Keep a dead Claude Code session alive. If `claude` exits, the session is gone — tmux or a wrapper process is the user's responsibility.
- Replace OpenClaw's autonomous agent runtime. Reder is a transport for Claude Code, not an agent orchestrator.
- Provide an admin dashboard, web UI, or hosted service. Self-hosted CLI only.
- Support API-key auth. Channels is a claude.ai / Pro / Max / Team feature. This is a property of the platform, not a Reder choice.
- Guarantee delivery across a Claude Code restart. If the session dies, queued messages are surfaced to the user on reconnect with a clear "session restarted" marker, not silently replayed into a new session context.

---

## 3. Design Principles

These are ordered by precedence. When they conflict, higher wins.

1. **Security over convenience.** The adapter is internet-exposed for webhooks and voice; it must not be a foothold. Every default is the safe default.
2. **Durability over throughput.** Every inbound message is persisted before acknowledgment. Slower is fine; losing a message is not.
3. **Official protocol over clever workarounds.** When Channels supports something, use it. Do not re-invent permission handling, sender gating, or event routing.
4. **Plugin boundary is a contract, not a convenience.** Core does not special-case the built-in adapters. If it's not expressible in the public adapter API, the API is wrong.
5. **One-command everything.** Install, configure, run, upgrade, diagnose.
6. **Observable by default.** Structured logs, a health endpoint, and a diagnostic command that doesn't require reading the code to use.
7. **Boring technology.** Node, SQLite, systemd. No Redis, no Postgres, no Kubernetes, no message broker. A single-binary, single-file-database deployment.

---

## 4. High-Level Architecture

### 4.1 The split

```
┌─────────────────────────────────────────────────────────────────┐
│  External transports                                            │
│                                                                 │
│    Telegram Bot API        Twilio Voice (Media Streams)         │
│          │                          │                           │
└──────────┼──────────────────────────┼───────────────────────────┘
           │                          │
           ▼                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  rederd — long-lived daemon (systemd)                          │
│                                                                 │
│    ┌──────────────┐   ┌──────────────┐   ┌──────────────┐       │
│    │ Telegram     │   │ Twilio Voice │   │ <plugin>     │       │
│    │ adapter      │   │ adapter      │   │ adapter      │       │
│    └──────┬───────┘   └──────┬───────┘   └──────┬───────┘       │
│           │                  │                  │               │
│           └──────────┬───────┴──────────────────┘               │
│                      ▼                                          │
│              ┌──────────────┐                                   │
│              │  Core Router │                                   │
│              └──────┬───────┘                                   │
│                     │                                           │
│       ┌─────────────┼──────────────────┐                        │
│       ▼             ▼                  ▼                        │
│  ┌─────────┐  ┌─────────┐       ┌─────────────┐                 │
│  │ Outbox  │  │ Session │       │ IPC         │                 │
│  │ (SQLite)│  │ Registry│       │ listener    │                 │
│  └─────────┘  └─────────┘       │ (unix sock) │                 │
│                                 └──────┬──────┘                 │
└────────────────────────────────────────┼────────────────────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
           ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
           │ reder-shim    │  │ reder-shim    │  │ reder-shim    │
           │ (MCP server)   │  │ (MCP server)   │  │ (MCP server)   │
           │ stdio ←→       │  │ stdio ←→       │  │ stdio ←→       │
           │ Claude Code    │  │ Claude Code    │  │ Claude Code    │
           │ session A      │  │ session B      │  │ session C      │
           └────────────────┘  └────────────────┘  └────────────────┘
```

**Two processes, one responsibility each:**

- **`rederd`** — The long-lived daemon. Owns all transport state, all durability, all routing. One instance per machine. Runs under systemd. Never embedded in Claude Code's process tree.
- **`reder-shim`** — The channel MCP server that Claude Code spawns as a subprocess via the `--channels` flag. Dumb, disposable, stateless. Its only job is to speak Claude Code's channel MCP protocol on one side and the Reder IPC protocol on the other. If it crashes, Claude Code respawns it; it reconnects to `rederd` and resumes.

### 4.2 Why the split matters

Every existing channel plugin holds transport state (Telegram polling offset, bot token, user pairings, in-flight permission prompts) inside the MCP subprocess that Claude Code spawned. When Claude Code restarts the subprocess — which it does on session reload, on MCP crashes, on `/mcp restart` — that state is gone. This is the structural source of the "messages dropped during restart" problem across the ecosystem.

By moving all stateful work into `rederd` and keeping `reder-shim` stateless, any lifecycle event in Claude Code's subprocess tree becomes invisible to the user. The shim respawns, reconnects to the daemon over a local Unix socket, identifies its session ID, and the daemon flushes any queued events. The user sees a brief "reconnecting" indicator in Telegram (not silence) and the conversation continues.

### 4.3 Message lifecycle (inbound, Telegram → Claude)

1. Telegram adapter (inside `rederd`) receives a message via long-poll `getUpdates`.
2. Adapter validates sender against the paired-user allowlist. Unpaired messages are dropped with a log line.
3. Adapter enqueues a normalized `InboundMessage` into the core router.
4. Core router resolves which session ID owns this sender → transport binding, writes the message to the SQLite outbox with state `received`, commits the transaction, **then** advances the Telegram offset.
5. Router attempts delivery to the shim over IPC. If the shim is connected, it forwards the MCP `notifications/claude/channel` event. State becomes `delivered`. If not connected, state stays `received`; delivery retries on reconnect.
6. Shim forwards the notification over stdio to Claude Code. Claude Code acknowledges receipt via the MCP protocol. Shim reports back to daemon. State becomes `acknowledged`.
7. Claude processes the message and invokes the `reply` tool to respond.

At any point, a crash of the shim leaves the outbox with `received` or `delivered` entries; on reconnect, the daemon replays all non-`acknowledged` rows in order.

### 4.4 Message lifecycle (outbound, Claude → Telegram)

1. Claude calls the `reply` tool exposed by the shim.
2. Shim forwards the call to the daemon over IPC.
3. Daemon writes to the outbox with state `pending`, commits.
4. Daemon hands to the Telegram adapter for send.
5. On Telegram API 200 OK with a message ID, state becomes `sent`. On Telegram API failure, the adapter retries with exponential backoff up to a configured limit, then surfaces an error back to the shim (which returns it as the tool result to Claude).

### 4.5 Permission relay lifecycle

Permission relay is the single feature where the Channels protocol does most of the work for us. The daemon implements the `claude/channel/permission` capability and the `notifications/claude/channel/permission_request` handler.

1. Claude invokes a tool that requires approval (Bash, Write, Edit, etc.). The local terminal dialog opens. The session waits.
2. Claude Code dispatches `notifications/claude/channel/permission_request` to the shim with `{request_id, tool_name, tool_input, command}`.
3. Shim forwards the full payload to the daemon over IPC.
4. Daemon persists an entry to the `permission_requests` table and dispatches to every bound transport for that session. For Telegram, this means an inline-keyboard message: "Allow" / "Deny" / "Always allow this tool". For Voice, it means a spoken prompt: "Claude wants to run `rm -rf build/`. Say allow or deny."
5. User replies. Transport parses response (button payload for Telegram, transcribed yes/no for Voice). Parsed verdict goes to the daemon.
6. Daemon sends `notifications/claude/channel/permission` to the shim with `{request_id, behavior: 'allow' | 'deny'}`.
7. Claude Code applies the verdict and closes the local dialog.

If the user answers in the terminal first, Claude Code applies that answer and the transport's prompt becomes stale; Reder edits the Telegram message to say "Answered at terminal: approved" and cancels any outstanding voice prompt.

"Always allow this tool" is a Reder-local shortcut — it records the tool name + input signature in a `persistent_approvals` table and auto-approves matches on subsequent requests without forwarding to the user. This is separate from Claude Code's own permission memory; it exists because the Channels protocol surfaces every prompt, and users doing 12-session work want to approve `Bash: npm test` once, not 200 times.

### 4.6 Voice lifecycle (Phase 2 preview)

Voice differs from text in one important way: it is a stateful bidirectional stream that cannot be queued. You can't "replay a phone call." The resilience model for voice is therefore different: the *call* is ephemeral, but the *conversation context* (what was transcribed, what was spoken back) is persisted in the outbox just like text, so a dropped call can be resumed by calling back in and being told "picking up where we left off".

- Inbound call hits a Twilio TwiML webhook served by `rederd` on an HTTPS port.
- Daemon answers with a `<Connect><Stream>` TwiML directive pointing at the daemon's WebSocket endpoint.
- Twilio opens the Media Stream WebSocket. Daemon authenticates the stream via the StreamSid, maps it to a session ID (via caller number → session binding in config).
- Inbound audio frames are pushed through a VAD (voice-activity detector) to chunk utterances, then to an STT provider (OpenAI Whisper over WebSocket, or local whisper.cpp), which produces transcribed text.
- Transcribed text is enqueued into the same outbox as a Telegram message would be, with `transport: 'voice'` and a call-session correlation ID. It flows through the router → shim → Claude Code identically.
- Claude replies via the `reply` tool. The daemon's voice adapter picks up the reply, pipes it to an TTS provider (ElevenLabs streaming), and writes the audio back into the Media Stream WebSocket as μ-law frames.
- Permission requests during a call render as spoken prompts with a 10-second wait for a yes/no; if ambiguous, the request is also sent to Telegram so the user can respond there instead.

---

## 5. The Plugin Boundary

### 5.1 What an adapter is

An adapter is a Node module (ESM) that exports a default class implementing the `Adapter` interface:

```typescript
// @rederjs/core/adapter.ts
export interface AdapterContext {
  readonly logger: Logger;
  readonly config: AdapterConfig;        // the section of reder.config.yaml for this adapter
  readonly storage: AdapterStorage;      // key-value store scoped to this adapter
  readonly router: RouterHandle;         // how the adapter sends inbound messages into the core
}

export interface InboundMessage {
  readonly transport: string;            // 'telegram', 'voice', 'slack', ...
  readonly sessionId: string;            // which Claude Code session this is bound to
  readonly senderId: string;             // transport-native sender identity, opaque to core
  readonly content: MessageContent;      // see below
  readonly correlationId?: string;       // for stateful conversations like voice calls
  readonly receivedAt: Date;
}

export type MessageContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; data: Uint8Array; caption?: string }
  | { kind: 'audio'; mimeType: string; data: Uint8Array; transcript?: string }
  | { kind: 'file'; mimeType: string; filename: string; data: Uint8Array };

export interface OutboundMessage {
  readonly sessionId: string;
  readonly recipient: string;            // the transport-native sender who this reply addresses
  readonly content: MessageContent | { kind: 'status'; text: string };
  readonly correlationId?: string;
  readonly inReplyTo?: string;           // for threaded contexts
}

export interface PermissionPrompt {
  readonly requestId: string;
  readonly sessionId: string;
  readonly recipient: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly command?: string;             // rendered command for display
  readonly expiresAt: Date;
}

export interface PermissionVerdict {
  readonly requestId: string;
  readonly behavior: 'allow' | 'deny';
  readonly respondent: string;           // who answered, for audit
}

export interface RouterHandle {
  ingestInbound(msg: InboundMessage): Promise<void>;
  ingestPermissionVerdict(verdict: PermissionVerdict): Promise<void>;
}

export abstract class Adapter {
  abstract readonly name: string;          // 'telegram', 'voice', etc. Must be unique.
  abstract start(ctx: AdapterContext): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendOutbound(msg: OutboundMessage): Promise<SendResult>;
  abstract sendPermissionPrompt(prompt: PermissionPrompt): Promise<void>;
  abstract cancelPermissionPrompt(requestId: string): Promise<void>;

  // Optional: lifecycle and diagnostics
  healthCheck?(): Promise<AdapterHealth>;
  onSessionBind?(binding: SessionBinding): Promise<void>;
  onSessionUnbind?(binding: SessionBinding): Promise<void>;
}

export interface SendResult {
  readonly success: boolean;
  readonly transportMessageId?: string;
  readonly retriable: boolean;
  readonly error?: string;
}

export interface AdapterHealth {
  readonly healthy: boolean;
  readonly connectedSince?: Date;
  readonly lastInboundAt?: Date;
  readonly lastOutboundAt?: Date;
  readonly details: Record<string, unknown>;
}
```

### 5.2 What the core provides

- `AdapterContext.logger` — structured logger scoped to the adapter's name.
- `AdapterContext.config` — the parsed and validated adapter-specific config block.
- `AdapterContext.storage` — a key-value store backed by the same SQLite file as the outbox, scoped so adapters cannot read each other's state. Used for things like Telegram's long-poll offset or Twilio's pending call map.
- `AdapterContext.router` — the only way an adapter injects events into the core. All inbound calls go through this interface; it enforces persistence, validation, and session binding before handing off.

### 5.3 What the core never does to an adapter

- Inspect or mutate its config beyond validation.
- Read its storage namespace.
- Call methods other than those on the `Adapter` interface.
- Assume anything about its transport semantics.

This is the contract that makes Reder pluggable. Core is adapter-agnostic; adapters are core-agnostic. If a future adapter needs a capability the core doesn't expose, the path is: propose a change to the `Adapter` interface in an RFC, not a special-case in the core.

### 5.4 Loading adapters

Adapters are declared in `reder.config.yaml`:

```yaml
adapters:
  telegram:
    module: '@rederjs/adapter-telegram'   # built-in
    enabled: true
    config:
      bots:
        - token_env: TELEGRAM_BOT_BOOKNERDS
          session_id: booknerds
        - token_env: TELEGRAM_BOT_MANGO
          session_id: mango
  voice:
    module: '@rederjs/adapter-voice'      # built-in, Phase 2
    enabled: false

  slack:
    module: '@community/reder-adapter-slack'   # third-party
    enabled: true
    config:
      workspace_id_env: SLACK_WORKSPACE
      bindings:
        - channel: '#booknerds-ops'
          session_id: booknerds
```

At startup, `rederd` resolves each module, instantiates its default export, and calls `start(ctx)`. Adapters that fail to start are logged loudly and retried with backoff, but do not prevent other adapters from starting.

### 5.5 Security boundary for third-party adapters

Third-party adapters run in the same process as `rederd` and therefore have the same privileges. Users installing community adapters accept this. We will document it plainly and provide guidance for auditing an adapter before use. A future phase may explore process-isolated adapters (subprocess + IPC), but is explicitly out of scope for v1.

---

## 6. Functional Requirements

### 6.1 Phase 1 — Telegram (MVP)

**F1.1** — Support multiple Telegram bot tokens in a single `rederd` instance, each bound to a distinct Claude Code session ID.

**F1.2** — Each bot operates in a private DM, a private supergroup, or a private supergroup with forum topics. The binding unit is `bot_token → session_id`. Multi-topic-per-session bindings are a configuration pattern, not a core concept.

**F1.3** — Inbound text messages from paired senders are forwarded to the bound session within 500ms of receipt under normal load.

**F1.4** — Inbound voice notes are transcribed via configurable STT provider (default: OpenAI Whisper) and forwarded as text with a `transcript:` prefix.

**F1.5** — Inbound images are forwarded to the session as `image` content, with caption treated as text.

**F1.6** — Inbound files up to 20 MB are forwarded to the session as `file` content.

**F1.7** — Outbound replies from Claude are rendered as Telegram messages. Long replies (> 4096 chars) are split on code-block or paragraph boundaries.

**F1.8** — Markdown in Claude replies is rendered as Telegram MarkdownV2 where possible; on rendering failure, message is sent as plain text with a log warning.

**F1.9** — Permission prompts are rendered as inline-keyboard messages with Allow, Deny, and "Always allow this tool" buttons. Timeout: 10 minutes, configurable.

**F1.10** — Pairing flow: on first DM from a new sender, the bot replies with a 6-character code. The user enters `/pair <code>` in any Claude Code session running the shim, which binds the sender to that session. Unpaired senders are silently dropped.

**F1.11** — `/status` command returns: session state, last activity timestamp, pending permission count, and recent tool calls.

**F1.12** — `/interrupt` command sends an interrupt signal to the session (equivalent to Ctrl+C at the terminal).

**F1.13** — Message acknowledgment: every inbound message persisted to SQLite before Telegram long-poll offset advances. No message loss across `rederd` restart.

### 6.2 Phase 1 — Core daemon

**F2.1** — Single-process daemon, one instance per machine. Concurrent instances are prevented via PID lockfile.

**F2.2** — IPC between `rederd` and `reder-shim` over Unix domain socket at `${runtime_dir}/rederd.sock`, with filesystem permissions `0600`.

**F2.3** — Shim connections are authenticated by a per-session token generated by `rederd` and retrieved by the shim via command-line argument at spawn time (written into the `.mcp.json` entry by the `reder sessions add` command).

**F2.4** — On shim disconnect, daemon holds outbound messages in the queue with state `delivered` until reconnection or a 24-hour TTL expires. On reconnect, unacknowledged messages replay in order.

**F2.5** — Daemon health endpoint: `GET http://127.0.0.1:${health_port}/health` returns `200 OK` with a JSON body containing per-adapter health, outbox depth, and last-activity timestamps. Bound to loopback only.

**F2.6** — Daemon metrics: same endpoint, `/metrics`, returns Prometheus-format metrics for outbox depth, adapter connection state, message counts by state, and permission-request counts.

**F2.7** — Graceful shutdown on SIGTERM: stop accepting new inbound, flush outbox, disconnect adapters cleanly, release IPC socket, exit within 10 seconds.

### 6.3 Phase 1 — Shim (MCP server)

**F3.1** — Implements the Channels MCP protocol: `claude/channel` capability, `claude/channel/permission` capability, `reply` tool, `notifications/claude/channel` notifications outbound, `notifications/claude/channel/permission_request` handler.

**F3.2** — stdin/stdout MCP stream to Claude Code. All stdio traffic is newline-delimited JSON-RPC as per MCP spec.

**F3.3** — Connects to `rederd.sock` at startup. Retries with exponential backoff (100ms → 30s) if the daemon is not yet available. Surfaces a clear error to Claude Code after 60s of failed retries.

**F3.4** — Forwards every event received from the daemon to Claude Code. Forwards every tool call and notification received from Claude Code to the daemon. No business logic in the shim.

**F3.5** — On Claude Code graceful shutdown (stdin EOF), shim disconnects cleanly and exits 0.

**F3.6** — On daemon disconnect while Claude Code is still attached, shim continues attempting reconnection and surfaces a clear status notification to Claude Code via an implementation-defined channel event.

### 6.4 Phase 2 — Twilio Voice

**F4.1** — Inbound voice calls on configured Twilio numbers are answered with a TwiML `<Connect><Stream>` directive.

**F4.2** — Twilio Media Streams WebSocket is terminated by the daemon's voice adapter on a configurable HTTPS port. TLS is mandatory.

**F4.3** — Caller identity (From number) maps to a session ID via config binding. Unknown callers hear "this number is not configured" and the call ends.

**F4.4** — Inbound audio is decoded from μ-law 8kHz, passed through a VAD, chunked into utterances, and sent to the STT provider.

**F4.5** — Transcribed utterances are enqueued as `InboundMessage` with `transport: 'voice'` and flow through the router identically to text.

**F4.6** — Claude replies trigger TTS via configured provider (default: ElevenLabs). Audio is streamed back through the Media Stream WebSocket as μ-law frames.

**F4.7** — During a call, permission prompts are rendered as spoken questions with a 10-second listening window; unparseable responses fall back to a Telegram prompt if that adapter is also bound.

**F4.8** — On caller hangup, the call is marked ended in the outbox. If Claude completes a response after hangup, it is stored and, if a Telegram binding exists, sent there with a prefix like "(voice call ended) ".

**F4.9** — Dropped Media Stream WebSocket (but not caller hangup) triggers a reconnect attempt for up to 15 seconds; Twilio supports this. If the user calls back within 5 minutes, they can resume with a "continue previous conversation" verbal prompt.

### 6.5 CLI (`reder`)

**F5.1** — `reder init` — machine-level setup wizard. Prompts for the web dashboard bind address (auto-detects a Tailscale IPv4 if `tailscale` is on `$PATH`) and port. Writes `~/.config/reder/reder.config.yaml` (web adapter enabled by default) and an empty `~/.config/reder/reder.env`. Re-runnable: re-runs preserve `sessions[]` and other adapters, only updating bind/port.

**F5.2** — `reder sessions add [session_id]` — registers a session for the current project. Appends/updates the YAML `sessions:` entry with `workspace_dir=cwd`, generates a token, writes `.mcp.json`, and optionally kicks off the daemon via `--auto-start`. Prompts interactively when no positional arg is given; fully non-interactive when one is. Idempotent — re-running rotates the shim token.

**F5.2a** — `reder sessions remove <session_id>` — removes a session. Cleans up the YAML entry, the SQLite session row (and its FK-referenced `bindings`), and the `reder` entry in the project's `.mcp.json` (preserving other mcpServers keys). Prompts to confirm; `-y` skips. `--keep-mcp` leaves `.mcp.json` untouched.

**F5.3** — `reder start` / `reder stop` / `reder restart` — service control (delegates to systemctl when available, direct process management otherwise).

**F5.4** — `reder status` — prints daemon status, per-adapter health, per-session state, outbox depth.

**F5.5** — `reder doctor` — runs diagnostic checks: daemon reachable, all adapters healthy, Claude Code version supports channels, `.mcp.json` entries valid, Telegram tokens reachable, required env vars present. Prints pass/fail for each.

**F5.6** — `reder logs [--follow] [--adapter NAME] [--session ID]` — tails structured logs with optional filters.

**F5.7** — `reder pair <code>` — (shim-mode) completes a Telegram pairing by writing the binding to the daemon.

**F5.8** — `reder upgrade` — pulls the latest release, runs migrations on the SQLite database, restarts the daemon. Refuses to run if the outbox has unacknowledged entries unless `--force`.

**F5.9** — `reder config edit` — opens the config in `$EDITOR`, validates on save, reloads the daemon.

**F5.10** — `reder config validate [path]` — validates a config file without applying.

**F5.11** — All commands accept `--json` for machine-readable output.

### 6.6 Configuration

**F6.1** — Single YAML file at `~/.config/reder/reder.config.yaml` (XDG-compliant). Override with `REDER_CONFIG`.

**F6.2** — Secrets never appear in the config file directly. All secret values are referenced via `${env:VAR_NAME}` or `${file:/path/to/secret}` indirection.

**F6.3** — Environment variables are loaded from `~/.config/reder/reder.env` (mode `0600`) if present.

**F6.4** — Schema is versioned. Config migrations run automatically on `reder upgrade`. Unknown fields produce warnings; malformed configs refuse to start.

**F6.5** — Hot reload on SIGHUP or `reder config reload`. Reloads do not drop in-flight messages.

**F6.6** — Per-session attachment cache lives at `<dataDir>/media/sessions/<session_id>/<sha256>.<ext>`. MIME allowlist: PNG, JPEG, GIF, WebP, PDF, Markdown, plain text. Per-file cap: 20 MB. Cache is wiped only by the future `reder sessions clear <id>` verb — `reder sessions restart` is non-destructive. See `docs/adapter-authoring.md#attachments` for the adapter-side convention.

### 6.7 Logging

**F7.1** — Structured JSON logs by default. Human-readable pretty format when stderr is a TTY or `--pretty` is passed.

**F7.2** — Log levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Default `info`.

**F7.3** — Every log entry includes: timestamp, level, component (e.g., `core.router`, `adapter.telegram`, `shim`), session_id (when applicable), correlation_id (when applicable), message, and a structured `fields` object.

**F7.4** — Logs are written to stderr. Systemd's journal captures them. Users can also configure a rotating file appender.

**F7.5** — Secret values in config, message payloads, and tokens are redacted from logs by a registered redactor list, never by regex on the final message. Redaction happens at the logger boundary.

**F7.6** — Message content is logged at `debug` only. At `info` and above, only metadata (lengths, types, correlation IDs) is logged.

**F7.7** — An audit log is emitted to a separate file at `${runtime_dir}/audit.log` for: pairings, unpairings, permission verdicts, `--dangerously-*` flag usage, config changes, adapter start/stop. Mode `0600`. Never truncated by log rotation (appended only, with daily-rolling filenames).

---

## 7. Non-Functional Requirements

### 7.1 Resilience

**NFR-R1** — Under a simulated drop of the Telegram HTTPS connection for 30 minutes with 100 queued-upstream messages, zero messages shall be lost and all shall be delivered to the session within 10 seconds of connection restoration.

**NFR-R2** — Under a simulated crash-loop of `reder-shim` (SIGKILL every 5 seconds for 2 minutes), zero acknowledged-inbound messages shall be lost or duplicated.

**NFR-R3** — Under a `rederd` cold restart with 1,000 pending outbox entries, recovery to full operation shall complete within 30 seconds.

**NFR-R4** — A Twilio Media Stream WebSocket drop shall be recovered within 15 seconds if the caller remains connected; caller-perceived audio interruption shall not exceed 3 seconds.

**NFR-R5** — Any single adapter failure shall not impair other adapters; the daemon shall continue operating with degraded functionality.

### 7.2 Performance

**NFR-P1** — Inbound Telegram message to session delivery: p50 < 200ms, p99 < 1s, under a load of 10 messages/second across 12 sessions.

**NFR-P2** — `rederd` steady-state memory footprint: < 150MB with 12 active sessions and no voice calls.

**NFR-P3** — `reder-shim` steady-state memory footprint: < 30MB per instance.

**NFR-P4** — SQLite outbox can sustain 100 writes/second on commodity hardware without WAL backpressure.

### 7.3 Maintainability

**NFR-M1** — All TypeScript. Strict mode, no implicit any, no unchecked errors. ESM modules throughout.

**NFR-M2** — Node 20+. Bun is tested but not required. (The official Channels plugins require Bun; Reder does not.)

**NFR-M3** — No runtime dependencies beyond:
- `@modelcontextprotocol/sdk` — required for the shim
- `better-sqlite3` — outbox
- `pino` — logging
- `zod` — schema validation
- `ws` — Twilio Media Streams (Phase 2)
- `yaml` — config parsing
- Adapter-specific clients (e.g., `grammy` for Telegram, `twilio` for voice)

**NFR-M4** — CI runs: typecheck, unit tests (> 80% coverage on core), integration tests against a local fakechat channel, lint (eslint + prettier), and a security audit (`npm audit --production`). All must pass for a merge.

**NFR-M5** — A single-command release script publishes versioned artifacts to npm and GitHub Releases, tags the commit, and updates the changelog.

### 7.4 Installability

**NFR-I1** — From zero on a supported OS: install, configure first session, and receive first Telegram message in under 10 minutes following the quickstart.

**NFR-I2** — Supported OS: Linux (systemd), macOS (launchd), Windows WSL2. Native Windows is explicitly not supported for v1.

**NFR-I3** — Single command install via npm: `npm install -g reder`.

**NFR-I4** — `reder init` must succeed on a machine with nothing but Node 20 installed. All other dependencies are optional or bundled.

**NFR-I5** — Upgrades via `reder upgrade` complete with zero manual steps in 99% of version transitions. Breaking migrations require a prompt.

### 7.5 Security

Given its own section below.

---

## 8. Security Model

### 8.1 Threat model

Adversaries we care about:

1. **Network attackers** reaching the Twilio webhook or health endpoints.
2. **Unauthorized Telegram users** discovering a bot and trying to push messages.
3. **Malicious third-party adapters** the user installs from npm.
4. **Local users** on a shared machine attempting to read secrets or inject events.
5. **A compromised upstream service** (Telegram, Twilio, OpenAI, ElevenLabs) attempting to pivot into the Reder host.

Adversaries we do not try to defend against:

- An attacker with root on the host. They already own the session.
- An attacker who has compromised the user's claude.ai credentials. They can already do everything the user can.
- Side-channel timing attacks on authentication.

### 8.2 Controls

**S1 — No inbound public ports in Phase 1.** Telegram is outbound-only (long-poll). The health endpoint binds to `127.0.0.1`. The IPC socket is `0600` on the filesystem. Phase 2 adds the Twilio webhook and WebSocket, which must be HTTPS-only and fronted by a domain with a valid cert.

**S2 — Sender allowlist enforced at the adapter boundary.** Every inbound message passes through a deny-by-default filter. Unpaired senders are dropped silently and audit-logged. Pairing requires out-of-band confirmation (the `/pair` code must be entered in a Claude Code session running the shim — this proves the sender has access to the session).

**S3 — Per-session shim tokens.** Every `reder-shim` instance authenticates to the daemon with a unique token. Token is generated by `reder sessions add <session_id>`, stored in the project's `.mcp.json` (which is `0600`), and presented on IPC connect. Tokens can be revoked via `reder sessions remove <session_id>`.

**S4 — Permission relay defaults to deny on timeout.** A permission prompt that expires without a verdict is treated as denied, not allowed.

**S5 — Twilio webhook signature validation.** All inbound Twilio HTTP requests are validated against Twilio's request-signing scheme. Unsigned or wrongly-signed requests are rejected with 403.

**S6 — Twilio caller allowlist.** Inbound calls from non-allowlisted numbers are dropped with a spoken "this number is not configured" message before any STT/TTS resources are allocated. This prevents resource exhaustion via spam calls.

**S7 — TLS for Twilio.** The Media Streams WebSocket endpoint is HTTPS with a valid certificate. Self-signed certs are refused. Let's Encrypt via cert-manager or Caddy is the documented path.

**S8 — Secret management.** No secrets in the main config file; `${env:}` and `${file:}` indirection only. The `reder.env` file is created `0600` and warned about if found otherwise. Secrets are never logged, never echoed in `reder status`, and never included in diagnostic dumps.

**S9 — Third-party adapter warnings.** On `rederd` startup, non-`@rederjs/*` adapter modules trigger a warning log entry indicating their provenance and version. `reder doctor` flags them in its report.

**S10 — Command injection defense in voice.** STT-transcribed text is never interpreted as a command by the daemon or shim. It is always content. The only commands the daemon accepts are the typed commands in the pairing flow and the IPC protocol from shims.

**S11 — Rate limiting.** Each paired sender is rate-limited to 60 inbound messages per minute per session by default, configurable. Exceeding the limit results in a throttle message in-channel and dropped events (not queued).

**S12 — Audit logging.** See F7.7. Every security-relevant event is audit-logged to an append-only file with `0600` permissions.

**S13 — Dependency hygiene.** Runtime dependency tree is minimized (NFR-M3). CI runs `npm audit --production` on every commit. High-severity advisories block release. Dependabot is enabled.

**S14 — No `eval` or dynamic code generation anywhere.** Enforced by lint rule.

**S15 — Outbox encryption at rest (optional).** SQLite file can be configured to use SQLCipher. Enabled via `storage.encryption: { key_env: REDER_DB_KEY }`. Off by default because the threat model already assumes the host is trusted; available for users with compliance requirements.

### 8.3 Security defaults

Every security decision defaults to the safer option:

| Decision | Default |
| --- | --- |
| Permission timeout behavior | Deny |
| Unknown sender | Drop |
| Malformed Twilio signature | Reject |
| Health port binding | Loopback only |
| IPC socket mode | 0600 |
| `reder.env` mode | 0600 |
| Third-party adapter | Warn loudly |
| Rate limit behavior on exceed | Drop |
| TLS | Required for Twilio |
| Logging of message bodies | Off at `info` level |

---

## 9. Data Model

SQLite, WAL mode, single file at `${data_dir}/reder.db`.

### 9.1 Tables

```sql
CREATE TABLE sessions (
  session_id      TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  shim_token_hash TEXT NOT NULL,         -- argon2id hash
  created_at      TIMESTAMP NOT NULL,
  last_seen_at    TIMESTAMP,
  state           TEXT NOT NULL CHECK (state IN ('registered', 'connected', 'disconnected', 'revoked'))
);

CREATE TABLE bindings (
  binding_id      TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(session_id),
  adapter         TEXT NOT NULL,
  sender_id       TEXT NOT NULL,         -- e.g. telegram user ID, twilio phone number
  created_at      TIMESTAMP NOT NULL,
  metadata        TEXT,                  -- JSON
  UNIQUE (adapter, sender_id, session_id)
);

CREATE TABLE inbound_messages (
  message_id      TEXT PRIMARY KEY,      -- uuid
  session_id      TEXT NOT NULL,
  adapter         TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  correlation_id  TEXT,
  content_kind    TEXT NOT NULL,
  content_meta    TEXT NOT NULL,         -- JSON (text, or metadata for binary)
  content_blob    BLOB,                  -- for images, audio, files
  received_at     TIMESTAMP NOT NULL,
  delivered_at    TIMESTAMP,
  acknowledged_at TIMESTAMP,
  state           TEXT NOT NULL CHECK (state IN ('received', 'delivered', 'acknowledged', 'failed'))
);
CREATE INDEX idx_inbound_state_session ON inbound_messages (state, session_id, received_at);

CREATE TABLE outbound_messages (
  message_id      TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  adapter         TEXT NOT NULL,
  recipient       TEXT NOT NULL,
  correlation_id  TEXT,
  content_kind    TEXT NOT NULL,
  content_meta    TEXT NOT NULL,
  content_blob    BLOB,
  created_at      TIMESTAMP NOT NULL,
  sent_at         TIMESTAMP,
  transport_msg_id TEXT,
  state           TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'expired')),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);
CREATE INDEX idx_outbound_state_adapter ON outbound_messages (state, adapter, created_at);

CREATE TABLE permission_requests (
  request_id      TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  tool_input      TEXT NOT NULL,         -- JSON
  command         TEXT,
  created_at      TIMESTAMP NOT NULL,
  expires_at      TIMESTAMP NOT NULL,
  resolved_at     TIMESTAMP,
  verdict         TEXT CHECK (verdict IN ('allow', 'deny', 'timeout', 'terminal')),
  respondent      TEXT
);

CREATE TABLE persistent_approvals (
  approval_id     TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  input_signature TEXT NOT NULL,         -- canonical hash of tool_input
  created_at      TIMESTAMP NOT NULL,
  respondent      TEXT NOT NULL,
  UNIQUE (session_id, tool_name, input_signature)
);

CREATE TABLE adapter_kv (
  adapter         TEXT NOT NULL,
  key             TEXT NOT NULL,
  value           BLOB NOT NULL,
  updated_at      TIMESTAMP NOT NULL,
  PRIMARY KEY (adapter, key)
);

CREATE TABLE schema_migrations (
  version         INTEGER PRIMARY KEY,
  applied_at      TIMESTAMP NOT NULL
);
```

### 9.2 Retention

- `inbound_messages` in state `acknowledged`: retained 7 days, then purged.
- `outbound_messages` in state `sent`: retained 7 days, then purged.
- `permission_requests`: retained 30 days for audit.
- `inbound_messages` and `outbound_messages` in terminal-error states (`failed`, `expired`): retained 30 days for diagnostics.

Retention is configurable per table.

---

## 10. IPC Protocol (daemon ↔ shim)

Length-prefixed JSON messages over the Unix domain socket. 4-byte big-endian length, followed by UTF-8 JSON.

### 10.1 Shim → Daemon

```typescript
type ShimToDaemon =
  | { kind: 'hello'; session_id: string; shim_token: string; shim_version: string; claude_code_version: string }
  | { kind: 'reply_tool_call'; request_id: string; content: MessageContent; in_reply_to?: string }
  | { kind: 'permission_request'; request_id: string; tool_name: string; tool_input: unknown; command?: string }
  | { kind: 'channel_ack'; message_id: string }       // acknowledging an inbound event from daemon
  | { kind: 'ping' };
```

### 10.2 Daemon → Shim

```typescript
type DaemonToShim =
  | { kind: 'welcome'; session_id: string; protocol_version: number }
  | { kind: 'channel_event'; message_id: string; payload: ClaudeChannelNotification }
  | { kind: 'permission_verdict'; request_id: string; behavior: 'allow' | 'deny' }
  | { kind: 'reply_tool_result'; request_id: string; success: boolean; error?: string }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'pong' };
```

### 10.3 Handshake

1. Shim connects to the socket.
2. Shim sends `hello` with its session ID and token.
3. Daemon verifies the token against the argon2id hash in `sessions`.
4. Daemon updates `sessions.state = 'connected'`, `last_seen_at = now()`.
5. Daemon sends `welcome`.
6. Daemon flushes any `received`/`delivered` inbound messages for this session.

### 10.4 Heartbeat

Shim sends `ping` every 5 seconds. Daemon replies with `pong`. Three missed pongs disconnect the shim (which triggers reconnect). Two missed pings on the daemon side mark the session as `disconnected` and start buffering.

---

## 11. Configuration Schema

```yaml
# reder.config.yaml

version: 1

runtime:
  runtime_dir: ~/.local/share/reder         # IPC socket, lockfiles
  data_dir: ~/.local/share/reder/data        # SQLite file

logging:
  level: info
  pretty: auto                                # auto | yes | no
  file:
    enabled: false
    path: ~/.local/share/reder/logs/reder.log
    rotate_size_mb: 50
    keep: 14

health:
  enabled: true
  bind: 127.0.0.1
  port: 7781

storage:
  retention:
    inbound_acknowledged_days: 7
    outbound_sent_days: 7
    permissions_days: 30
    terminal_errors_days: 30
  encryption:
    enabled: false
    key_env: REDER_DB_KEY                    # if enabled

security:
  rate_limit:
    per_sender_per_minute: 60
  permission_default_on_timeout: deny
  permission_timeout_seconds: 600

sessions:
  - session_id: booknerds
    display_name: BookNerds
  - session_id: mango
    display_name: Mango Policy

adapters:
  telegram:
    module: '@rederjs/adapter-telegram'
    enabled: true
    config:
      bots:
        - token_env: TELEGRAM_BOT_BOOKNERDS
          session_id: booknerds
          allow_groups: false
          allow_topics: true
        - token_env: TELEGRAM_BOT_MANGO
          session_id: mango
      rendering:
        markdown: true
        code_block_threshold_chars: 60
      stt:
        provider: openai-whisper
        api_key_env: OPENAI_API_KEY

  voice:
    module: '@rederjs/adapter-voice'
    enabled: false
    config:
      twilio:
        account_sid_env: TWILIO_ACCOUNT_SID
        auth_token_env: TWILIO_AUTH_TOKEN
        signing_secret_env: TWILIO_SIGNING_SECRET
      listener:
        bind: 0.0.0.0
        port: 7782
        tls:
          cert_file: /etc/letsencrypt/live/reder.example.com/fullchain.pem
          key_file: /etc/letsencrypt/live/reder.example.com/privkey.pem
      stt:
        provider: openai-whisper-streaming
        api_key_env: OPENAI_API_KEY
      tts:
        provider: elevenlabs
        api_key_env: ELEVENLABS_API_KEY
        voice_id: 'your-voice-id'
      callers:
        - phone: '+15551234567'
          session_id: booknerds
        - phone: '+15557654321'
          session_id: mango
```

Validation with zod. On startup, schema errors produce a readable report naming the path and the violation.

---

## 12. Project Structure

```
reder/
├── package.json                           # workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .github/workflows/
│   ├── ci.yml
│   └── release.yml
├── docs/
│   ├── quickstart.md
│   ├── architecture.md                    # adapted from this document
│   ├── adapter-authoring.md
│   └── security.md
├── packages/
│   ├── core/                              # @rederjs/core
│   │   ├── src/
│   │   │   ├── adapter.ts                 # Adapter interface
│   │   │   ├── router.ts                  # Core Router
│   │   │   ├── outbox.ts                  # SQLite outbox
│   │   │   ├── ipc/                       # daemon-side IPC
│   │   │   ├── sessions.ts
│   │   │   ├── permissions.ts
│   │   │   ├── config.ts                  # schema + loader
│   │   │   ├── logger.ts
│   │   │   └── health.ts
│   │   └── test/
│   ├── daemon/                            # @rederjs/daemon — the rederd binary
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── bootstrap.ts
│   │   │   ├── lifecycle.ts
│   │   │   └── systemd.ts
│   │   └── test/
│   ├── shim/                              # @rederjs/shim — the reder-shim binary
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── mcp-server.ts              # implements Channels protocol
│   │   │   └── ipc-client.ts
│   │   └── test/
│   ├── cli/                               # @rederjs/cli — the reder binary
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── commands/
│   │   │   │   ├── init.ts
│   │   │   │   ├── install.ts
│   │   │   │   ├── start.ts
│   │   │   │   ├── status.ts
│   │   │   │   ├── doctor.ts
│   │   │   │   ├── logs.ts
│   │   │   │   ├── pair.ts
│   │   │   │   ├── upgrade.ts
│   │   │   │   └── config.ts
│   │   │   └── prompts.ts
│   │   └── test/
│   ├── adapter-telegram/                  # @rederjs/adapter-telegram
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── long-poll.ts
│   │   │   ├── rendering.ts
│   │   │   ├── pairing.ts
│   │   │   └── permission-prompt.ts
│   │   └── test/
│   └── adapter-voice/                     # @rederjs/adapter-voice  (Phase 2)
│       ├── src/
│       │   ├── index.ts
│       │   ├── twilio-webhook.ts
│       │   ├── media-stream.ts
│       │   ├── stt/
│       │   ├── tts/
│       │   └── call-session.ts
│       └── test/
└── examples/
    ├── quickstart/                        # a minimal working config
    └── custom-adapter/                    # template for community adapters
```

### 12.1 Release artifacts

- npm: each package published individually under the `@rederjs/` scope.
- GitHub Releases: a single meta-package `reder` that, when globally installed, provides the `reder`, `rederd`, and `reder-shim` binaries.
- Optional: a standalone binary built with `@vercel/pkg` or `bun build --compile` for users who don't want a Node dependency. Stretch goal for v1.

---

## 13. Roadmap

### Phase 0 — Foundations (Week 0-1)

- Workspace scaffolding, CI, lint, test infrastructure.
- Core router, outbox schema, config loader, logging.
- IPC protocol between daemon and shim.
- `reder-shim` speaking the Channels MCP protocol end-to-end against the official `fakechat` plugin for comparison.

**Exit criterion:** A Claude Code session started with `--dangerously-load-development-channels server:reder-shim` can send text messages to a CLI script that reads them off the IPC socket, and vice versa, through `rederd`.

### Phase 1 — Telegram (Week 1-3)

- Telegram adapter with long-poll, sender allowlist, pairing flow.
- Permission relay end-to-end with inline keyboards.
- Markdown rendering, long-message splitting.
- Voice-note STT.
- `reder init`, `reder sessions add`, `reder sessions remove`, `reder doctor`, `reder status`, `reder logs`.
- Documentation: quickstart, config reference, security doc.

**Exit criterion:** 12-session local test. Send messages to each bot, observe delivery, approve permissions, intentionally kill `reder-shim` with `kill -9` during an active conversation, verify zero message loss and visible reconnect UX.

### Phase 2 — Voice (Week 4-6)

- Twilio webhook with signature validation.
- Media Stream WebSocket terminator.
- STT and TTS pipelines with configurable providers.
- Voice permission prompts.
- Call-in resume semantics.

**Exit criterion:** Make a phone call to a configured session, ask it a question, get a voiced reply, approve a permission verbally, hang up, call back and resume.

### Phase 3 — Polish and Launch (Week 6-8)

- Publishing automation.
- Standalone binary artifact.
- Community adapter template + authoring guide.
- Demo video (the phone-call clip).
- Blog post: technical writeup of durability design and permission relay.
- Submit to Anthropic's community channel marketplace.

### Post-launch roadmap (not v1)

- Slack adapter (community or first-party).
- Additional STT/TTS providers.
- Webhooks adapter (for CI/CD events pushed into sessions).
- Web-based admin dashboard (opt-in, separate package).
- Process-isolated third-party adapters.

---

## 14. Testing Strategy

### 14.1 Unit tests

- Core router: message lifecycle state transitions, retry semantics, outbox consistency.
- Config loader: schema validation edge cases, env/file indirection, migration logic.
- Permission manager: timeout behavior, race between terminal and relay answer, persistent approvals.
- Adapter telegram: pairing flow, rendering, rate limiting, allowlist.

Target: > 80% line coverage on `@rederjs/core`, > 70% on adapters.

### 14.2 Integration tests

- `reder-shim` against a mock MCP client simulating Claude Code.
- `rederd` with a fake adapter that deterministically injects messages, crashes, and reconnects. Asserts no message loss.
- End-to-end: real `claude` binary, real `rederd`, fake Telegram adapter driving the test.

### 14.3 Chaos tests

Dedicated test suite, runs in CI on a nightly schedule:

- Kill `reder-shim` every N seconds under load; verify zero loss.
- Partition the Telegram adapter from the network for N minutes; verify recovery.
- Inject SQLite corruption; verify the outbox recovers to a consistent state.
- Restart `rederd` mid-stream; verify message continuity.

### 14.4 Security tests

- Fuzzing the IPC protocol.
- Fuzzing the Twilio webhook endpoint.
- Tests for pairing-code brute force (rate limit, attempt lockout).
- Tests for permission-timeout default behavior.
- Static analysis: `eslint-plugin-security`, `semgrep`.

### 14.5 Manual acceptance

The demo script (the phone call video) is rehearsed before each release. It doubles as a smoke test and a marketing asset.

---

## 15. Operational Runbook Excerpts

Included in the v1 docs, summarized here.

### 15.1 "My messages stopped arriving"

1. `reder doctor`. Every failing check has a remediation.
2. `reder status`. Is the adapter connected? Is the shim connected?
3. `reder logs --follow --session $ID`. Look for `error` or `warn`.
4. Check the outbox: `reder status --json | jq '.outbox'`. Is there backpressure?
5. If the adapter is unhealthy, check the upstream (Telegram status page, Twilio console).
6. Restart: `reder restart`. No state is lost.

### 15.2 "I want to upgrade"

`reder upgrade`. It will refuse if the outbox has unacked entries and tell you how many. Resolve those first (or `--force` to proceed, accepting that they will be retried after upgrade).

### 15.3 "I want to back up"

The SQLite file at `${data_dir}/reder.db` plus the config and env files. `reder backup` produces a single tarball with all three. Encrypted if the DB is encrypted.

### 15.4 "A sender is misbehaving"

`reder block <adapter> <sender_id>` adds the sender to a deny list that supersedes the allowlist. `reder unblock` reverses it.

---

## 16. Open Questions

These are worth resolving before or during implementation.

1. **Claude Code channel plugin distribution.** The official path is `/plugin install`. Can `reder sessions add <session_id>` write an entry into Claude Code's plugin config, or does it have to write only `.mcp.json`? Need to verify what Claude Code 2.1.81+ accepts for custom channels beyond `--dangerously-load-development-channels`.

2. **Applying for the allowlist.** Once the project is stable, pursue inclusion in `claude-plugins-official` or an adjacent trusted marketplace so users don't need the `--dangerously-` flag. Track the process with Anthropic DevRel.

3. **Bun vs Node for the shim.** The official plugins use Bun. Node works per the protocol spec. Supporting both is cheap. Decision: support both, default to Node for wider compatibility, document Bun for users who want startup speed.

4. **Voice provider abstraction.** STT and TTS pluggability needs its own sub-interface within the voice adapter. Ship v1 with OpenAI Whisper + ElevenLabs and leave the abstraction as a smaller internal contract; formalize it in v2.

5. **Multi-machine deployments.** Out of scope for v1. All components run on one host. A future `@rederjs/gateway` could relay between a cloud-hosted ingress and a private daemon, but needs its own threat model.

---

## 17. Success Criteria

The project is successful if, 90 days after v1.0:

- At least 100 GitHub stars (proxy for community interest).
- At least 3 community-authored adapters (proxy for API quality).
- Zero confirmed message-loss bug reports (proxy for durability design).
- A documented blog post or talk referenced by Anthropic DevRel (proxy for alignment with platform).
- At least one inbound request from Anthropic or a major agent-tooling publication to include Reder in a roundup or partnership list (proxy for positioning).

If three of these five are met, the project has served its purpose.

---

*End of document.*
