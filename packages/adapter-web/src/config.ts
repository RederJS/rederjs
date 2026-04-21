import { z } from 'zod';

export const WebAdapterConfigSchema = z
  .object({
    bind: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(7781),
    auth: z.enum(['token', 'none']).default('token'),
    host_allowlist: z.array(z.string().min(1)).default([]),
    /**
     * Optional override for where the dashboard token is persisted.
     * Defaults to <data_dir>/dashboard.token.
     */
    token_path: z.string().optional(),
    /** When true, issue cookies with the Secure flag (use behind TLS). */
    secure_cookie: z.boolean().default(false),
    /** When true, exposes `/health` publicly (no auth). Default: true. */
    expose_health: z.boolean().default(true),
    /**
     * Sender id used when the dashboard ingests a message (for pairings table
     * display and audit). One dashboard == one operator.
     */
    sender_id: z.string().default('web:local'),
  })
  .strict()
  .default({});

export type WebAdapterConfig = z.infer<typeof WebAdapterConfigSchema>;
