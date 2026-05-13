# @rederjs/shim

The reder MCP shim — an MCP server (`reder-shim`) that Claude Code loads per project via `.mcp.json`. It authenticates with an argon2id-hashed session token, then proxies channel events (`<channel source="reder">…</channel>`) and `reply` tool calls to and from the [reder daemon](https://github.com/mred9/reder) over a Unix socket. Also ships `reder-hook`, the binary Claude Code session-activity hooks invoke.

You don't install this package directly. It comes along with the CLI:

```sh
npm install -g rederjs
```

That ships both `reder-shim` and `reder-hook` on your `PATH`. `reder sessions add` writes the `.mcp.json` and hook entries that point at them — installation per project is automatic from there.

See also: the [main repo README](https://github.com/mred9/reder#readme) for the system architecture diagram and the [development guide](https://github.com/mred9/reder/blob/main/docs/development.md) for how Claude Code, the shim, and the daemon fit together.
