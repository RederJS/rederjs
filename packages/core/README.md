# @rederjs/core

Shared building blocks for the [reder](https://github.com/RederJS/rederjs) daemon and adapters: the message router, IPC codec and Unix-socket server, SQLite storage layer (with migrations), session model, audit log, rate limiter, pairing protocol, tmux helpers, and the `Adapter` interface every adapter implements.

If you're writing your own adapter (Slack, IRC, SMS…), this is the package you import from. See [adapter authoring](https://github.com/RederJS/rederjs/blob/main/docs/adapter-authoring.md) for the interface contract and walkthrough.

## Install

```sh
npm install @rederjs/core
```

Exposes a [rich `exports` map](./package.json) — import only what you need:

```ts
import { Adapter, type AdapterContext } from '@rederjs/core/adapter';
import { Router } from '@rederjs/core/router';
import { openDb } from '@rederjs/core/storage/db';
```

## Where this fits

`@rederjs/core` is consumed by `@rederjs/daemon`, `@rederjs/shim`, `rederjs` (CLI), and both first-party adapters. It does not run on its own.

See also: the [main repo README](https://github.com/RederJS/rederjs#readme) for the system architecture diagram.
