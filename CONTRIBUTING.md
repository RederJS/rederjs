# Contributing to Reder

Thanks for your interest. Reder is small enough that the contribution flow is deliberately light.

## Dev setup

See [docs/development.md](docs/development.md) for the full dev loop (linking workspace bins, TypeScript watch mode, dashboard HMR, the Telegram adapter against a dev bot). Short version:

```sh
npm install
npm run build
npm test
```

Node 20+ required. Use `npm` — the repo is npm workspaces, not pnpm or yarn.

## Test, lint, typecheck

```sh
npm test          # vitest
npm run lint      # eslint + prettier --check
npm run typecheck # all workspaces
npm run build     # build every package
npm run format    # prettier --write (when lint complains)
```

## Commit style

Repo follows [Conventional Commits](https://www.conventionalcommits.org/). Scope is the package name when applicable. `git log --oneline` shows the style:

```
feat(adapter-web): wire Composer mic to useSpeechRecognition
fix(security): enforce allow_groups for Telegram chat-type gating
chore: prep monorepo for first npm publish + open-source release
```

Keep messages imperative ("add", "fix", "remove").

## Pull requests

- Branch from `main`. One purpose per PR.
- Link the issue you're closing (`Closes #123`) in the PR body.
- Keep diffs reviewable; split refactors from feature work when natural.
- We follow the [Contributor Covenant](https://www.contributor-covenant.org/) as our code of conduct.

### Before opening a PR

- [ ] `npm run lint` clean
- [ ] `npm run typecheck` clean
- [ ] `npm test` passes
- [ ] `npm run build` succeeds for every workspace

For bugs and feature requests, open a GitHub issue. For security problems, see [SECURITY.md](SECURITY.md) — do not file a public issue.
