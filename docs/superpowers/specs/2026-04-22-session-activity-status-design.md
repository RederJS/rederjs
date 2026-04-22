# Session Activity Status — Design

**Date:** 2026-04-22
**Status:** Approved (brainstorm). Pending implementation plan.

## Problem

The web dashboard's job is to tell the user which Claude Code sessions need their attention. Today the status dot is derived client-side from a 2-minute outbound-recency heuristic:

- `offline` — tmux not running
- `waiting` — unread > 0
- `busy` — Claude sent an outbound message in the last 2 minutes
- `idle` — anything else

That heuristic is wrong in both directions:

- **False idle.** Claude grinds on a long task for 10 minutes without emitting an outbound; the UI shows `idle`. The user thinks the session needs work when it doesn't.
- **False busy.** Claude finishes and goes quiet; the UI shows `busy` for 2 minutes. The user ignores a session that's actually awaiting them.

The dashboard is an attention router. Both failure modes defeat its purpose.

## Requirement

One hard invariant: if a session is actually working, the UI must show it as working — and conversely, any session that is NOT working (idle, blocked on a question, blocked on a permission, offline) must surface to the user.

No heuristic satisfies this — the router needs ground truth on "is Claude currently processing right now."

## Signal source

Claude Code's hook system is the right source. Hooks fire at exact lifecycle moments and don't require parsing terminal output.

Three hooks are captured:

- `SessionStart` → Claude is now active
- `UserPromptSubmit` → a prompt has been submitted; Claude is working
- `Stop` → Claude has finished responding to the current prompt

(`PreToolUse` / `PostToolUse` are deliberately out of scope for v1. They're useful for a later "currently running: Bash(...)" indicator but add noise to the state calculation.)

### Delivery path

Reder ships a new entry point (`reder-hook` — a subcommand of the existing shim binary or a sibling binary; whichever fits the build/package layout best). Claude Code invokes it per hook; it:

1. Reads the Claude hook JSON payload from stdin.
2. Connects to the daemon's existing Unix socket.
3. Authenticates using the same per-session token already stored in `.mcp.json`.
4. Sends one `hook_event` IPC message.
5. Exits.

The hook command line, written into `.claude/settings.local.json`:

```
reder-hook --session-id <sid> --socket <path> --token <token>
```

Same auth token, same socket, same provenance as the shim — no new secret surface.

## State model

The router maintains per-session activity state, derived from hook events + existing router signals (permissions, unread, shim connected, tmux running).

| State | Meaning | Attention? |
|---|---|---|
| **working** | Claude is actively processing a prompt or running tools | no — leave alone |
| **awaiting-user** | Claude finished, and there's an unread outbound reply or a pending permission request | yes |
| **idle** | Claude finished and upstream is acknowledged — ready for new work | yes |
| **unknown** | shim connected but we've never received a hook event (session predates the feature, hooks were stripped, or Claude Code hooks are broken) | yes, with a "repair" nudge |
| **offline** | tmux not running OR shim disconnected | yes |

### Transitions

- `SessionStart`, `UserPromptSubmit` → **working**
- `Stop` → **awaiting-user** if (unread outbound OR pending permission), else **idle**
- `permission.requested` while working → stays **working** (the request is part of active work); while idle/awaiting → **awaiting-user**
- `permission.resolved` → recompute from current signals
- unread count drops to zero while awaiting-user with no pending permission → **idle**
- shim disconnect OR tmux stop → **offline**
- shim connects but no hook events yet → **unknown**

### Not persisted

Activity state is ephemeral. On daemon restart everything starts as `unknown` until the next hook fires (which happens on the next Claude interaction anyway). This avoids a class of stale-state bugs.

## IPC protocol

One new `ShimToDaemon` message:

```ts
{
  kind: 'hook_event',
  session_id: string,
  hook: 'SessionStart' | 'UserPromptSubmit' | 'Stop' | 'SessionEnd',
  timestamp: string,            // ISO-8601
  payload?: Record<string, unknown>  // opaque passthrough from Claude's hook JSON
}
```

The hook binary sends `hello` (same flow as the shim) followed by `hook_event`, then disconnects. No long-lived connection — hooks are one-shot invocations.

Router emits a new event to adapters:

```ts
'session.activity_changed': {
  sessionId: string,
  state: 'working' | 'awaiting-user' | 'idle' | 'unknown' | 'offline',
  since: string,  // ISO timestamp of the transition
  lastHook?: 'SessionStart' | 'UserPromptSubmit' | 'Stop' | 'SessionEnd',
}
```

## Config management

`reder sessions add` writes `.claude/settings.local.json` alongside the existing `.mcp.json` write.

**Why `settings.local.json` and not `settings.json`:** the hook command contains a session token and an absolute socket path. `settings.json` is typically checked into the repo; `settings.local.json` is not. Session tokens must not enter version control.

### Merge semantics

- If `.claude/settings.local.json` exists: parse, add/update reder's hook entries, preserve everything else.
- If it doesn't exist: create it with only our entries.
- Reder's entries are tagged so they can be recognized by `sessions remove` and `sessions repair`. Tagging approach: wrap each hook entry in an object with a recognizable `name` field (e.g. `"name": "reder-session-activity"`) OR use a sibling `_reder_session_id` marker — whichever the Claude Code hook schema tolerates. (Final choice deferred to implementation, based on the schema.)

### `reder sessions remove`

Strips only reder-tagged entries from `.claude/settings.local.json`. Leaves user-authored hooks untouched. Removes the file only if it becomes empty (no other user content) after stripping.

### New command: `reder sessions repair [id]`

Re-writes `.mcp.json` and `.claude/settings.local.json` for a session whose files are missing, outdated, or diverged from the current daemon config. Idempotent — safe to run repeatedly. This is the remediation path that doctor points users to.

## UI surfacing

### Server-authoritative status

The web adapter stops deriving status client-side. The server sends the authoritative state via the existing SSE stream (`session.activity_changed` event) and as a new `activity_state` field on `GET /api/sessions` responses.

The client-side `deriveStatus` function in `packages/adapter-web/web/src/derive.ts` and the `BUSY_WINDOW_MS` constant are removed.

### Status rendering

`StatusPill` and `Avatar` components get the new states:

- `working` — subdued/dim (de-emphasized; "don't look at me")
- `awaiting-user` — accent color (user attention needed)
- `idle` — neutral
- `unknown` — muted with a small warning glyph
- `offline` — gray

### Sort & grouping in `SessionGrid`

Default sort becomes **attention-first**:

```
awaiting-user → idle → unknown → offline → working (last)
```

The existing sort toggle (`priority | recent | name`) stays. "Priority" now means attention-priority instead of the current heuristic.

Optional (may be cut based on implementation feel): render two visual sections — "Needs you" above, "Working" collapsed below with a count. If the separation adds UI complexity without clear value once the sort is in place, omit it.

### Unknown-state remediation

The `unknown` badge is clickable. It hits a new `POST /api/sessions/:id/repair` endpoint (authenticated like the rest of the API) that runs the same logic as the CLI `sessions repair` command. The user fixes the session from the dashboard without dropping to a terminal.

## Validation & doctor

Additions to `reder doctor`:

- **Per session with `workspace_dir`**: check that `<workspace>/.claude/settings.local.json` exists AND contains reder's hook block. Remediation: `reder sessions repair <id>`.
- **Hook command resolvability**: the command in the hook entry must resolve on PATH (or be an absolute path that exists). Catches the case where the user moved/reinstalled reder.
- **Socket path currency**: the socket path in the hook command must match the current `runtime_dir`. Catches moved-runtime-dir drift. Remediation: same repair command.
- **Activity signal liveness (informational)**: for each currently-connected shim, report whether a hook event has ever been received in this daemon's lifetime. If shim has been connected for more than ~30 seconds with zero hook events received on any session, flag — suggests hooks are silently not firing.

### Startup validation

The daemon logs a warning (not a fatal error) at boot for each auto-started session whose hook config is missing. Daemon startup is not blocked by this.

## Fallback / compatibility

- Sessions that predate this feature, or whose hooks have been stripped, render as `unknown`. There is **no silent fall back to the old outbound-recency heuristic** — that's precisely how we end up lying about busy state.
- For a grace period of one release, the API response keeps the old `last_outbound_at`-based fields alongside the new `activity_state`. After that release they're removed.
- The old `deriveStatus` function is deleted when the server-authoritative state ships. No dead code.

## Out of scope (v1)

- `PreToolUse` / `PostToolUse` hooks. Useful later for a "currently running: Bash(...)" ticker but add noise to state calculation.
- Full terminal mirroring via `tmux pipe-pane`. Separate roadmap item; may replace or augment this later but doesn't block v1.
- Persisted activity state across daemon restarts. Ephemeral by design.
- Cross-session aggregate metrics (e.g. "4 of 7 sessions working"). Can be derived from the API; doesn't need to be a first-class feature.

## Risks and open questions

- **Hook schema tagging.** Final choice between a `name` field and a sibling marker depends on the exact Claude Code hook schema. Resolved during implementation.
- **Concurrent prompts.** If Claude supports multiple overlapping user prompts in one session, a single `working` bit may be too coarse. Current assumption: Claude Code is single-prompt-at-a-time per session; `UserPromptSubmit`/`Stop` balance 1:1. Revisit if that assumption breaks.
- **Hook firing latency.** There may be a small delay between Claude finishing and the `Stop` hook firing. Acceptable for v1 — it's still vastly more accurate than the current 2-minute window.
- **User-disabled hooks.** A user can strip reder's hooks manually. Doctor's liveness check catches this after ~30s; otherwise the `unknown` label catches it on next session restart.
