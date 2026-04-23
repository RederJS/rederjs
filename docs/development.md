# Developing Reder locally

This guide takes you from a fresh clone to a working dev loop where edits to any package are picked up without reinstalling anything.

## Prerequisites

- **Node 20+** (`node --version`)
- **Claude Code 2.1.81+** (`claude --version`) — older versions work for inbound/outbound messages but not the permission relay
- **tmux** on `$PATH` if you want to exercise `auto_start` / `reder sessions start`
- **git**
- Optional: a Telegram bot token from [@BotFather](https://t.me/BotFather) if you plan to touch the Telegram adapter

## Clone, install, build, test

```sh
git clone https://github.com/…/reder
cd reder
npm install
npm run build
npm test
```

`npm install` wires up the npm workspaces in `packages/*`. `npm run build` compiles every package's TypeScript into its local `dist/`.

## Workspace layout

```
packages/
  core/              # shared: router, IPC, storage, tmux, sessions, config, audit
  daemon/            # rederd — long-running process, adapter host
  shim/              # reder-shim — MCP server Claude Code loads per project
  cli/               # reder — the CLI
  adapter-telegram/  # Telegram bot adapter
  adapter-web/       # Dashboard — Express + SSE backend, Vite + React SPA
```

Two things to know about `@rederjs/core`:

- It publishes a rich `exports` map (`@rederjs/core/adapter`, `@rederjs/core/router`, `@rederjs/core/ipc/codec`, etc.). When adding a new module, update `packages/core/package.json` `exports`.
- Its `build` script isn't just `tsc` — it also copies `src/storage/migrations/*.sql` into `dist/storage/migrations/`. That matters for the dev loop below.

## The dev loop

The three binaries — `reder`, `rederd`, `reder-shim` — all live in `packages/*/dist/`. Link them into your global npm prefix once, and they'll resolve to the workspace. Then keep TypeScript compiling on save, and edits show up on the next invocation.

### 1. Link the workspace bins (one-time)

```sh
npm run link
```

That's shorthand for linking `rederjs`, `@rederjs/daemon`, and `@rederjs/shim` into your global npm prefix. Confirm:

```sh
which reder rederd reder-shim
# all three should resolve under your npm global prefix
```

Linking `@rederjs/shim` isn't optional, even if you're only hacking on the daemon or the web adapter. `reder sessions add` writes a `.mcp.json` that references `reder-shim` by bare name, so Claude Code spawns it via `$PATH` — without the link, local Claude sessions can't reach your dev daemon.

### 2. Keep TypeScript watching

```sh
npm run watch
```

(`npm run dev` is an alias.) This runs `tsc -b` across every package in watch mode. Leave it running in a terminal — on each save it re-emits only the affected packages.

### 3. Iterate

- Edit anything under `packages/*/src/` → wait for tsc to re-emit → re-run the command.
- CLI change: just run `reder …` again.
- Daemon or adapter change: `reder restart`, then exercise.
- Shim change: start a fresh `claude` session in a workspace where you've run `reder sessions add` (the shim process lives for the life of the Claude Code process).

**Migration caveat.** `tsc --watch` does *not* copy SQL. If you edit anything under `packages/core/src/storage/migrations/`, re-run:

```sh
npm run build -w @rederjs/core
```

That invokes `tsc` plus the `cpSync` step in core's `build` script.

### Session activity hooks

Reder installs three Claude Code hooks per session (`SessionStart`, `UserPromptSubmit`, `Stop`) into `<workspace>/.claude/settings.local.json`. They invoke the `reder-hook` binary, which forwards the lifecycle event to the daemon so the dashboard can tell the difference between a session that is working and one that needs attention.

If a session shows `unknown` in the dashboard, the hook block is missing or stale. Run:

    reder sessions repair <session-id>

to re-install it. `reder doctor` reports which sessions are missing hooks.

To debug hook invocations, set `REDER_HOOK_DEBUG=1` in Claude Code's environment — the `reder-hook` binary will emit stderr lines describing socket connect failures or fatal errors. Default (unset) behavior is silent so hooks never break Claude's flow.

## Dashboard UI with hot reload

The React SPA has its own Vite dev server that proxies `/api` to the real daemon, so you get HMR against live data:

```sh
# terminal 1
reder start

# terminal 2
npm run dev:web
```

(That's an alias for `npm run dev:web -w @rederjs/adapter-web`.)

Open the URL Vite prints. API calls hit `127.0.0.1:7781` (your dev daemon); SPA code reloads on save.

## Exercising the Telegram adapter locally

Create a separate dev bot via @BotFather — don't share a bot between your personal setup and a dev checkout, since only one process can long-poll a given bot at a time.

```sh
echo 'TELEGRAM_BOT_TOKEN=<your-dev-bot-token>' >> ~/.config/reder/reder.env
chmod 600 ~/.config/reder/reder.env
reder restart
```

Pair it the same way a user would:

1. DM the dev bot — it replies with a pair code.
2. In a workspace where you've run `reder sessions add`, run `reder pair <code>`.

Never commit `reder.env` or a real bot token. `~/.config/reder/reder.env` lives outside the repo by design.

## Alternative: run from `dist/` without linking

If you'd rather not touch your global npm prefix:

```sh
node packages/cli/dist/index.js status
node packages/daemon/dist/index.js
```

The limitation: `reder sessions add` still writes `.mcp.json` entries that reference `reder-shim` by bare name, so Claude Code can't find the shim without help. You'll either need to `npm link -w @rederjs/shim` anyway, or hand-edit each generated `.mcp.json` to use an absolute path to `packages/shim/dist/index.js`. For most contributors, the `npm link` path above is less friction.

## Tests, typecheck, lint

```sh
npm test               # vitest run
npm run test:watch
npm run typecheck      # all workspaces
npm run lint           # eslint + prettier --check
npm run format         # prettier --write
```

Run these before opening a PR.

## Cleanup

```sh
npm run unlink
```

After that, `which reder` should report "not found" again (or point at a previously-installed published version).

## Commit style

Repo follows Conventional Commits. Scopes are the package name when applicable:

```
feat(cli): add `reder sessions up`
fix(adapter-telegram): retry on 429
chore: bump vitest
docs(development): clarify migration caveat
```

`git log --oneline` shows the existing style.
