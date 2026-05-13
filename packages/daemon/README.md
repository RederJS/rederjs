# @rederjs/daemon

The reder daemon (`rederd`) — a long-running process that hosts the Unix socket every Claude Code shim connects to, owns the SQLite store, runs the configured adapters, and serves the web dashboard. Part of the [reder](https://github.com/mred9/reder) project.

You typically don't install this package directly. It comes along with the CLI:

```sh
npm install -g rederjs
```

That ships the `rederd` binary on your `PATH` alongside `reder` and `reder-shim`.

Run it via the CLI rather than invoking it by hand:

```sh
reder start     # start the daemon (writes a systemd user unit on Linux)
reder status    # query its HTTP API
reder restart   # restart after a config change
```

See also: the [main repo README](https://github.com/mred9/reder#readme) for the architecture diagram and configuration reference.
