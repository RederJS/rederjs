# Changelog

All notable changes to reder are documented here. The project adheres to
[Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `npm run release -- <patch|minor|major|x.y.z>` lockstep release helper.
  Bumps every workspace + the root, rewrites inter-package dep ranges to
  the new version, refreshes the lockfile, moves the `[Unreleased]`
  changelog heading into a dated section, then commits and tags. Prints
  the dependency-ordered `npm publish` commands at the end — actual
  publishing is left to the operator (needs npm auth).

## [0.1.0] — first public release

First real publish of the `rederjs` CLI and `@rederjs/*` packages. Replaces
the `0.0.1-placeholder.0` namespace placeholder.

### Packages

Six npm packages publish at this version:

- `rederjs` — CLI (`reder` binary) and entry point. Pulls in the daemon,
  shim, and bundled adapters as runtime deps so a single
  `npm install -g rederjs` yields a working install.
- `@rederjs/core` — config, IPC, sessions, storage, audit, router, health.
- `@rederjs/daemon` — `rederd` binary; bridges Claude Code sessions to
  remote adapters.
- `@rederjs/shim` — `reder-shim` (MCP server) and `reder-hook` (hook CLI)
  binaries, invoked from inside Claude Code sessions.
- `@rederjs/adapter-telegram` — Telegram channel adapter.
- `@rederjs/adapter-web` — browser dashboard adapter.

### Added

- `reder sessions repair` accepts no args (interactive picker) and
  `--all` for non-interactive bulk repair (#58).
- Hook installer (`@rederjs/cli`) now detects and removes legacy unmarked
  Claude Code hook entries on re-install/repair, in addition to entries
  carrying the `_reder_session_id` marker (#58).

### Changed

- **Daemon → CLI dependency cycle removed** — `@rederjs/daemon` no longer
  declares `rederjs` as a dep. The `hasClaudeHooks` warning at boot is
  now a best-effort dynamic import; if the CLI isn't installed alongside
  the daemon, the check is silently skipped.
- **Daemon no longer hard-declares any adapter package.** Adapters are
  loaded dynamically from config (`await import(spec)`); declaring them
  as deps was a leftover from the original `adapter-telegram`-only setup.
- `vite` bumped from `^5.4.0` to `^6.4.2` to close
  [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9)
  (path traversal in optimized-deps `.map` handling) and
  [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)
  (esbuild dev-server unrestricted CORS, transitively) (#59).
- `vitest` bumped from `^2.0.0` to `^3.2.4`; root `overrides` block
  removed since vitest 3 dedupes naturally to a single vite (#60).

### Fixed

- Repair / re-install of Claude Code hooks no longer leaves stale legacy
  entries in `.claude/settings.local.json` — those carried inline
  `--token` values that became invalid after token rotation, causing
  every prompt/session/stop event to fire a failing hook (#58).

[Unreleased]: https://github.com/mred9/reder/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mred9/reder/releases/tag/v0.1.0
