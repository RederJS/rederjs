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
    /**
     * Cookie `Secure` flag policy.
     * - `true`: always set Secure. Use this when you know the dashboard is
     *   only ever served over HTTPS (direct TLS or via a TLS-aware proxy
     *   with `app.set('trust proxy', …)` upstream).
     * - `false`: never set Secure. Required for plain-HTTP localhost.
     * - `'auto'` (default): set Secure iff the request is TLS. Detected via
     *   `req.secure` (requires Express `trust proxy`) or
     *   `X-Forwarded-Proto: https`. Safe behaviour for the common cases:
     *   plain HTTP at home, HTTPS behind Caddy/nginx in production.
     *
     * Migration note: prior versions defaulted to `false`. Users running
     * the dashboard over plain HTTP do not need to change anything — the
     * new `'auto'` default sees a non-TLS request and omits `Secure`.
     */
    secure_cookie: z.union([z.boolean(), z.literal('auto')]).default('auto'),
    /**
     * When true, exposes `/health` and `/healthz` without authentication.
     * **Restricted to loopback** even when true: callers from non-loopback
     * remote addresses (including hosts on `host_allowlist`) receive 403.
     * If you need external health checks, put an authenticated reverse
     * proxy in front of the daemon and call `/health` from the proxy.
     *
     * Default changed from `true` → `false` in v0.x: the snapshot exposes
     * adapter state that may include sensitive details. Existing
     * deployments that rely on the unauthenticated endpoint must opt in
     * by setting `expose_health: true` explicitly.
     */
    expose_health: z.boolean().default(false),
    /**
     * Sender id used when the dashboard ingests a message (for pairings table
     * display and audit). One dashboard == one operator.
     */
    sender_id: z.string().default('web:local'),
  })
  .strict()
  .default({});

export type WebAdapterConfig = z.infer<typeof WebAdapterConfigSchema>;
