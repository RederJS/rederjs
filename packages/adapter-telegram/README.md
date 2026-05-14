# @rederjs/adapter-telegram

The reder Telegram adapter — DM your Claude Code sessions, receive replies, and approve permission prompts from your phone. Built on [grammY](https://grammy.dev/). Part of the [reder](https://github.com/RederJS/rederjs) project.

## Install

```sh
npm install @rederjs/adapter-telegram
```

Then create a bot via [@BotFather](https://t.me/BotFather), drop the token into `~/.config/reder/reder.env`, and enable the adapter in `~/.config/reder/reder.config.yaml`:

```yaml
adapters:
  telegram:
    module: '@rederjs/adapter-telegram'
    enabled: true
    config:
      bots:
        - session_id: reder
          token: ${env:TELEGRAM_BOT_TOKEN}
```

Pair the bot to a project: DM it to get a pair code, then run `reder pair <code>` from a workspace where you've already run `reder sessions add`.

See also: the [main repo README](https://github.com/RederJS/rederjs#readme) for the Telegram quickstart and architecture diagram.
