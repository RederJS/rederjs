import { z } from 'zod';

export const TelegramAdapterConfigSchema = z.object({
  mode: z.enum(['pairing', 'allowlist']).default('pairing'),
  allowlist: z.array(z.string().regex(/^\d+$/)).default([]),
  bots: z
    .array(
      z.object({
        /**
         * Name of an env var holding the bot token. Preferred over inline `token`
         * for any deployed environment — the token never appears in the config
         * file, in `git diff` output, or in shell history.
         */
        token_env: z.string().min(1).optional(),
        /**
         * Discouraged: inline bot token. Convenient for first-run smoke tests
         * but should be replaced with `token_env` before committing the config
         * or sharing a config file. Will be removed from `reder.config.yaml`
         * dumps in a future release.
         */
        token: z.string().min(1).optional(),
        session_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,62}$/),
        allow_groups: z.boolean().default(false),
        allow_topics: z.boolean().default(true),
      }),
    )
    .default([]),
  rendering: z
    .object({
      markdown: z.boolean().default(true),
      code_block_threshold_chars: z.number().int().positive().default(60),
    })
    .default({}),
  long_poll_timeout_seconds: z.number().int().min(1).max(300).default(30),
});

export type TelegramAdapterConfig = z.infer<typeof TelegramAdapterConfigSchema>;
