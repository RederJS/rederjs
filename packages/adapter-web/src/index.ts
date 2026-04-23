import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { Database as Db } from 'better-sqlite3';
import {
  Adapter,
  type AdapterContext,
  type AdapterHealth,
  type OutboundMessage,
  type PermissionPrompt,
  type SendResult,
  type InboundPersistedPayload,
  type OutboundPersistedPayload,
  type PermissionRequestedPayload,
  type PermissionResolvedPayload,
  type SessionStateChangedPayload,
  type SessionActivityChangedPayload,
} from '@rederjs/core/adapter';
import { WebAdapterConfigSchema, type WebAdapterConfig } from './config.js';
import { createSseRegistry, type SseRegistry } from './sse.js';
import { buildApp, listen } from './http.js';
import { loadOrCreateToken, buildLoginUrl } from './auth.js';
import { incrementUnread } from './routes/sessions.js';
import { getSessionActivity } from './transcript.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Shipped SPA dist — <package>/dist/../web/dist */
const DEFAULT_STATIC_DIR = join(__dirname, '..', 'web', 'dist');

export interface WebAdapterOptions {
  /**
   * Override the filesystem location of the built SPA. Defaults to
   * <package>/web/dist.
   */
  staticDir?: string;
  /**
   * Optional injected DB. When not provided, the adapter will read from
   * `(ctx as { db?: Db }).db` if the host supplies it. In normal operation
   * the daemon wires a `db` handle through AdapterContext augmentation.
   */
  db?: Db;
  /** Optional pre-built health snapshot function. */
  healthSnapshot?: () => Promise<unknown>;
}

/**
 * Extended AdapterContext that the daemon populates with direct references
 * the web adapter needs. These fields are non-standard but the adapter host
 * in this project supplies them when loading @rederjs/adapter-web.
 */
interface WebAdapterContext extends AdapterContext {
  db?: Db;
  healthSnapshot?: () => Promise<unknown>;
}

export class WebAdapter extends Adapter {
  override readonly name = 'web';
  private ctx!: WebAdapterContext;
  private cfg!: WebAdapterConfig;
  private sse!: SseRegistry;
  private server: Server | null = null;
  private token!: string;
  private tokenPath!: string;
  private connectedSince: Date | null = null;
  private lastInboundAt: Date | null = null;
  private lastOutboundAt: Date | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly opts: WebAdapterOptions = {}) {
    super();
  }

  override async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx as WebAdapterContext;
    const parsed = WebAdapterConfigSchema.safeParse(ctx.config ?? {});
    if (!parsed.success) {
      throw new Error(`invalid web adapter config: ${parsed.error.message}`);
    }
    this.cfg = parsed.data;

    const db = this.opts.db ?? this.ctx.db;
    if (!db) {
      throw new Error(
        '@rederjs/adapter-web requires a database handle (host must supply ctx.db or constructor opts.db)',
      );
    }

    // Token.
    this.tokenPath = this.cfg.token_path ?? join(this.ctx.dataDir, 'dashboard.token');
    if (this.cfg.auth === 'token') {
      const t = loadOrCreateToken(this.tokenPath);
      this.token = t.token;
      if (t.created) {
        this.ctx.logger.info(
          { token_path: this.tokenPath, component: 'adapter.web' },
          'generated new dashboard token',
        );
      }
    } else {
      this.token = '';
      this.ctx.logger.warn(
        { component: 'adapter.web' },
        'dashboard auth disabled (auth: none) — rely on upstream auth (Caddy, SSO, etc.)',
      );
    }

    this.sse = createSseRegistry(this.ctx.logger.child({ component: 'adapter.web.sse' }));

    // Subscribe to router events → fan out to SSE.
    this.subscribe();

    const app = buildApp({
      auth: {
        mode: this.cfg.auth,
        token: this.token,
        hostAllowlist: [this.cfg.bind, ...this.cfg.host_allowlist],
        secureCookie: this.cfg.secure_cookie,
      },
      db,
      router: this.ctx.router,
      storage: this.ctx.storage,
      logger: this.ctx.logger,
      sessions: this.ctx.sessions.map((s) => ({
        session_id: s.session_id,
        display_name: s.display_name,
        ...(s.workspace_dir !== undefined ? { workspace_dir: s.workspace_dir } : {}),
        auto_start: s.auto_start,
      })),
      sse: this.sse,
      adapterName: this.name,
      senderId: this.cfg.sender_id,
      healthSnapshot:
        this.opts.healthSnapshot ??
        this.ctx.healthSnapshot ??
        (async (): Promise<unknown> => ({
          ok: true,
          adapter: 'web',
          sessions: this.ctx.sessions.length,
        })),
      staticDir: this.opts.staticDir ?? DEFAULT_STATIC_DIR,
      exposeHealth: this.cfg.expose_health,
    });

    this.server = await listen(app, this.cfg.bind, this.cfg.port);
    this.connectedSince = new Date();

    const url = buildLoginUrl({
      bind: this.cfg.bind,
      port: this.cfg.port,
      token: this.token,
    });
    this.ctx.logger.info(
      {
        bind: this.cfg.bind,
        port: this.cfg.port,
        auth: this.cfg.auth,
        component: 'adapter.web',
      },
      this.cfg.auth === 'token'
        ? `dashboard listening. First-time URL: ${url}`
        : 'dashboard listening (auth disabled)',
    );
  }

  override async stop(): Promise<void> {
    for (const off of this.unsubscribers) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    this.unsubscribers = [];
    this.sse?.closeAll();
    if (this.server) {
      await new Promise<void>((res) => this.server!.close(() => res()));
      this.server = null;
    }
    this.connectedSince = null;
  }

  override async sendOutbound(msg: OutboundMessage): Promise<SendResult> {
    // When Claude replies to a web-originated message, we push the outbound
    // straight to subscribed dashboards. Persistence happens in the router.
    this.lastOutboundAt = new Date();
    this.sse.publish(msg.sessionId, {
      event: 'outbound',
      data: {
        sessionId: msg.sessionId,
        content: msg.content,
        meta: msg.meta,
        files: msg.files,
      },
    });
    return { success: true, retriable: false };
  }

  override async sendPermissionPrompt(prompt: PermissionPrompt): Promise<void> {
    this.sse.publish(prompt.sessionId, {
      event: 'permission.requested',
      data: {
        requestId: prompt.requestId,
        sessionId: prompt.sessionId,
        toolName: prompt.toolName,
        description: prompt.description,
        inputPreview: prompt.inputPreview,
        expiresAt: prompt.expiresAt.toISOString(),
      },
    });
  }

  override async cancelPermissionPrompt(
    requestId: string,
    finalVerdict?: string,
  ): Promise<void> {
    this.sse.broadcast({
      event: 'permission.cancelled',
      data: { requestId, ...(finalVerdict !== undefined ? { finalVerdict } : {}) },
    });
  }

  override async healthCheck(): Promise<AdapterHealth> {
    return {
      healthy: this.server !== null,
      ...(this.connectedSince ? { connectedSince: this.connectedSince } : {}),
      ...(this.lastInboundAt ? { lastInboundAt: this.lastInboundAt } : {}),
      ...(this.lastOutboundAt ? { lastOutboundAt: this.lastOutboundAt } : {}),
      details: {
        bind: this.cfg?.bind,
        port: this.cfg?.port,
        auth: this.cfg?.auth,
        open_streams: this.sse?.size() ?? 0,
      },
    };
  }

  private subscribe(): void {
    const events = this.ctx.router.events;

    const onInbound = (p: InboundPersistedPayload): void => {
      this.lastInboundAt = new Date(p.receivedAt);
      // If an inbound came from another adapter (e.g. Telegram), still push it
      // to the dashboard so transcript stays live.
      this.sse.publish(p.sessionId, {
        event: 'inbound',
        data: p,
      });
      // Bump unread unless it's from this adapter (user typed it in).
      if (p.adapter !== this.name) {
        void incrementUnread(this.ctx.storage, p.sessionId)
          .then((n) => {
            this.ctx.router.notifyUnread(p.sessionId, n);
          })
          .catch(() => {});
      }
    };
    const onOutbound = (p: OutboundPersistedPayload): void => {
      this.lastOutboundAt = new Date(p.createdAt);
      this.sse.publish(p.sessionId, {
        event: 'outbound.persisted',
        data: p,
      });
    };
    const onPermReq = (p: PermissionRequestedPayload): void => {
      this.sse.publish(p.sessionId, {
        event: 'permission.requested',
        data: p,
      });
    };
    const onPermRes = (p: PermissionResolvedPayload): void => {
      this.sse.publish(p.sessionId, {
        event: 'permission.resolved',
        data: p,
      });
    };
    const onState = (p: SessionStateChangedPayload): void => {
      this.sse.broadcast({
        event: 'session.state_changed',
        data: p,
      });
    };
    const onActivity = (p: SessionActivityChangedPayload): void => {
      this.sse.broadcast({
        event: 'session.activity_changed',
        data: p,
      });
    };

    events.on('inbound.persisted', onInbound);
    events.on('outbound.persisted', onOutbound);
    events.on('permission.requested', onPermReq);
    events.on('permission.resolved', onPermRes);
    events.on('session.state_changed', onState);
    events.on('session.activity_changed', onActivity);

    this.unsubscribers.push(
      () => events.off('inbound.persisted', onInbound),
      () => events.off('outbound.persisted', onOutbound),
      () => events.off('permission.requested', onPermReq),
      () => events.off('permission.resolved', onPermRes),
      () => events.off('session.state_changed', onState),
      () => events.off('session.activity_changed', onActivity),
    );

    // Suppress unused-variable warnings.
    void getSessionActivity;
  }
}

export default WebAdapter;
export { WebAdapterConfigSchema, type WebAdapterConfig };
export { buildLoginUrl, loadOrCreateToken } from './auth.js';
