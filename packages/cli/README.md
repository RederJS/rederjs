# rederjs

The `reder` CLI — configure the daemon, register Claude Code sessions, manage tmux auto-start, and pair Telegram bots. Part of the [reder](https://github.com/RederJS/rederjs) project.

## Install

```sh
npm install -g rederjs
```

This pulls in `@rederjs/daemon` and `@rederjs/shim` as dependencies and ships three binaries on your `PATH`:

| Binary       | Role                                                        |
| ------------ | ----------------------------------------------------------- |
| `reder`      | The CLI (this package)                                      |
| `rederd`     | Long-running daemon (from `@rederjs/daemon`)                |
| `reder-shim` | MCP server Claude Code loads per project (from `@rederjs/shim`) |

## Quickstart

```sh
reder init                       # configure the daemon
cd ~/code/myproject
reder sessions add --auto-start  # register the project
reder dashboard url              # print the authenticated dashboard URL
```

See also: the [main repo README](https://github.com/RederJS/rederjs#readme) for full setup, configuration, and the architecture diagram.
