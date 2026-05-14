# @rederjs/adapter-web

The reder web adapter — an Express + Server-Sent Events backend plus a React + Tailwind SPA. Gives you a browser dashboard with one card per Claude Code session, a live merged transcript, a permission-approval banner, and a composer with browser-side voice input. Part of the [reder](https://github.com/RederJS/rederjs) project.

## Install

```sh
npm install @rederjs/adapter-web
```

Then enable it in `~/.config/reder/reder.config.yaml`:

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

Loopback-bound and token-authenticated by default. Run `reder dashboard url` to get the authenticated URL.

See also: the [main repo README](https://github.com/RederJS/rederjs#readme) for the architecture diagram and [docs/security.md](https://github.com/RederJS/rederjs/blob/main/docs/security.md) for the web-adapter threat model.
