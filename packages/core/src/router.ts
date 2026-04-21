import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Database as Db } from 'better-sqlite3';
import type { Logger } from 'pino';
import type {
  Adapter,
  InboundMessage,
  OutboundMessage,
  PermissionVerdict,
  RouterEventMap,
  RouterEvents,
  RouterHandle,
} from './adapter.js';
import {
  insertInbound,
  markInboundDelivered,
  markInboundAcknowledged,
  insertOutbound,
  markOutboundSent,
  markOutboundFailed,
  incrementOutboundAttempt,
  listPendingInboundForSession,
} from './storage/outbox.js';
import type {
  IpcServer,
  ReplyToolCallEvent,
  ChannelAckEvent,
  PermissionRequestEvent,
  AdminPairRequestEvent,
} from './ipc/server.js';
import type { AuditLog } from './audit.js';
import { PermissionManager, type PermissionManagerOptions } from './permissions.js';
import {
  lookupPairCode,
  consumePairCode,
  createBinding,
  createPairCode as createPairCodeRecord,
  isPaired as isPairedDb,
} from './pairing.js';
import type { Config } from './config.js';

export interface RouterOptions {
  db: Db;
  ipcServer: IpcServer;
  logger: Logger;
  audit: AuditLog;
  config?: Pick<Config, 'sessions'>;
  permissions?: Partial<PermissionManagerOptions>;
  outboundMaxAttempts?: number;
  outboundInitialBackoffMs?: number;
}

export interface AdapterRegistration {
  adapter: Adapter;
}

export interface Router extends RouterHandle {
  registerAdapter(name: string, reg: AdapterRegistration): void;
  unregisterAdapter(name: string): void;
  permissions(): PermissionManager;
  stop(): Promise<void>;
}

interface LastInboundBySession {
  adapter: string;
  senderId: string;
  messageId: string;
}

const OUTBOUND_DEFAULT_MAX_ATTEMPTS = 5;
const OUTBOUND_DEFAULT_INITIAL_BACKOFF_MS = 250;

export function createRouter(opts: RouterOptions): Router {
  const { db, ipcServer, logger, audit } = opts;
  const adapters = new Map<string, AdapterRegistration>();
  const lastInboundBySession = new Map<string, LastInboundBySession>();

  const emitter = new EventEmitter();
  emitter.setMaxListeners(64);

  function emit<K extends keyof RouterEventMap>(event: K, payload: RouterEventMap[K]): void {
    emitter.emit(event, payload);
  }

  const events: RouterEvents = {
    on: (event, listener) => {
      emitter.on(event, listener as (...args: unknown[]) => void);
    },
    off: (event, listener) => {
      emitter.off(event, listener as (...args: unknown[]) => void);
    },
  };

  const permissions = new PermissionManager({
    db,
    adapters: {
      send: async (name, prompt) => {
        const reg = adapters.get(name);
        if (!reg) return;
        await reg.adapter.sendPermissionPrompt(prompt);
      },
      cancel: async (name, requestId, finalVerdict) => {
        const reg = adapters.get(name);
        if (!reg) return;
        await reg.adapter.cancelPermissionPrompt(requestId, finalVerdict);
      },
      allNames: () => [...adapters.keys()],
    },
    logger: logger.child({ component: 'core.permissions' }),
    audit,
    timeoutSeconds: opts.permissions?.timeoutSeconds ?? 600,
    defaultOnTimeout: opts.permissions?.defaultOnTimeout ?? 'deny',
    dispatchVerdict: (sessionId, requestId, behavior) => {
      ipcServer.sendToSession(sessionId, {
        kind: 'permission_verdict',
        request_id: requestId,
        behavior,
      });
    },
    onResolved: (info) => {
      emit('permission.resolved', info);
    },
  });

  // IPC event wiring -----------------------------------------------------------

  ipcServer.on('shim_connected', (sessionId) => {
    emit('session.state_changed', { sessionId, state: 'connected' });
    void flushPendingForSession(sessionId);
  });

  ipcServer.on('shim_disconnected', (sessionId) => {
    emit('session.state_changed', { sessionId, state: 'disconnected' });
  });

  ipcServer.on('channel_ack', (evt: ChannelAckEvent) => {
    markInboundAcknowledged(db, evt.message_id);
  });

  ipcServer.on('reply_tool_call', (evt: ReplyToolCallEvent) => {
    void handleReplyToolCall(evt);
  });

  ipcServer.on('permission_request', (evt: PermissionRequestEvent) => {
    const expiresAt = new Date(
      Date.now() + (opts.permissions?.timeoutSeconds ?? 600) * 1000,
    ).toISOString();
    emit('permission.requested', {
      requestId: evt.request_id,
      sessionId: evt.session_id,
      toolName: evt.tool_name,
      description: evt.description,
      inputPreview: evt.input_preview,
      expiresAt,
    });
    void permissions.handleRequest(evt);
  });

  ipcServer.on('admin_pair_request', (evt: AdminPairRequestEvent) => {
    void handleAdminPairRequest(evt);
  });

  // Inbound path ---------------------------------------------------------------

  async function deliverInbound(sessionId: string, messageId: string, content: string, meta: Record<string, string>): Promise<void> {
    const sent = ipcServer.sendToSession(sessionId, {
      kind: 'channel_event',
      message_id: messageId,
      content,
      meta,
    });
    if (sent) {
      markInboundDelivered(db, messageId);
    }
  }

  async function flushPendingForSession(sessionId: string): Promise<void> {
    const rows = listPendingInboundForSession(db, sessionId);
    for (const row of rows) {
      await deliverInbound(sessionId, row.message_id, row.content, row.meta);
    }
    logger.debug(
      { session_id: sessionId, count: rows.length, component: 'core.router' },
      'flushed pending inbound for session',
    );
  }

  // Outbound path --------------------------------------------------------------

  function resolveRecipient(sessionId: string, inReplyTo?: string): { adapter: string; recipient: string } | null {
    if (inReplyTo) {
      const row = db
        .prepare(
          `SELECT adapter, sender_id FROM inbound_messages WHERE message_id = ? AND session_id = ?`,
        )
        .get(inReplyTo, sessionId) as { adapter: string; sender_id: string } | undefined;
      if (row) return { adapter: row.adapter, recipient: row.sender_id };
    }
    const last = lastInboundBySession.get(sessionId);
    if (last) return { adapter: last.adapter, recipient: last.senderId };

    const row = db
      .prepare(
        `SELECT adapter, sender_id FROM inbound_messages
          WHERE session_id = ?
          ORDER BY received_at DESC, message_id DESC
          LIMIT 1`,
      )
      .get(sessionId) as { adapter: string; sender_id: string } | undefined;
    if (row) return { adapter: row.adapter, recipient: row.sender_id };
    return null;
  }

  async function dispatchOutboundWithRetry(
    reg: AdapterRegistration,
    msg: OutboundMessage,
    messageId: string,
  ): Promise<{ success: boolean; error?: string; transportMessageId?: string }> {
    const maxAttempts = opts.outboundMaxAttempts ?? OUTBOUND_DEFAULT_MAX_ATTEMPTS;
    const initialBackoff = opts.outboundInitialBackoffMs ?? OUTBOUND_DEFAULT_INITIAL_BACKOFF_MS;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      incrementOutboundAttempt(db, messageId);
      const result = await reg.adapter.sendOutbound(msg);
      if (result.success) {
        return {
          success: true,
          ...(result.transportMessageId !== undefined
            ? { transportMessageId: result.transportMessageId }
            : {}),
        };
      }
      if (!result.retriable || attempt === maxAttempts) {
        return { success: false, error: result.error ?? 'send failed' };
      }
      await new Promise((r) => setTimeout(r, initialBackoff * 2 ** (attempt - 1)));
    }
    return { success: false, error: 'exhausted retries' };
  }

  async function handleReplyToolCall(evt: ReplyToolCallEvent): Promise<void> {
    const resolved = resolveRecipient(evt.session_id, evt.in_reply_to);
    if (!resolved) {
      ipcServer.sendToSession(evt.session_id, {
        kind: 'reply_tool_result',
        request_id: evt.request_id,
        success: false,
        error: 'no recipient bound to session',
      });
      return;
    }
    const reg = adapters.get(resolved.adapter);
    if (!reg) {
      ipcServer.sendToSession(evt.session_id, {
        kind: 'reply_tool_result',
        request_id: evt.request_id,
        success: false,
        error: `adapter '${resolved.adapter}' not registered`,
      });
      return;
    }
    const messageId = randomUUID();
    const createdAt = new Date().toISOString();
    insertOutbound(db, {
      message_id: messageId,
      session_id: evt.session_id,
      adapter: resolved.adapter,
      recipient: resolved.recipient,
      content: evt.content,
      meta: evt.meta,
      files: evt.files,
    });
    emit('outbound.persisted', {
      messageId,
      sessionId: evt.session_id,
      adapter: resolved.adapter,
      recipient: resolved.recipient,
      content: evt.content,
      meta: evt.meta,
      files: evt.files,
      createdAt,
    });
    const outbound: OutboundMessage = {
      sessionId: evt.session_id,
      adapter: resolved.adapter,
      recipient: resolved.recipient,
      content: evt.content,
      meta: evt.meta,
      files: evt.files,
      ...(evt.in_reply_to !== undefined ? { inReplyTo: evt.in_reply_to } : {}),
    };
    const result = await dispatchOutboundWithRetry(reg, outbound, messageId);
    if (result.success) {
      markOutboundSent(db, messageId, result.transportMessageId);
      emit('outbound.sent', {
        messageId,
        sessionId: evt.session_id,
        adapter: resolved.adapter,
        recipient: resolved.recipient,
        content: evt.content,
        meta: evt.meta,
        files: evt.files,
        createdAt,
        sentAt: new Date().toISOString(),
        ...(result.transportMessageId !== undefined
          ? { transportMessageId: result.transportMessageId }
          : {}),
      });
      ipcServer.sendToSession(evt.session_id, {
        kind: 'reply_tool_result',
        request_id: evt.request_id,
        success: true,
      });
    } else {
      markOutboundFailed(db, messageId, result.error ?? 'unknown error');
      ipcServer.sendToSession(evt.session_id, {
        kind: 'reply_tool_result',
        request_id: evt.request_id,
        success: false,
        error: result.error ?? 'send failed',
      });
    }
  }

  // Admin pair request ---------------------------------------------------------

  async function handleAdminPairRequest(evt: AdminPairRequestEvent): Promise<void> {
    const code = evt.code.toLowerCase();
    const rec = lookupPairCode(db, code);
    if (!rec) {
      ipcServer.sendToSession(evt.session_id, {
        kind: 'admin_pair_result',
        success: false,
        error: 'pairing code not found or expired',
      });
      return;
    }
    if (isPairedDb(db, rec.adapter, rec.senderId, evt.session_id)) {
      consumePairCode(db, code);
      ipcServer.sendToSession(evt.session_id, {
        kind: 'admin_pair_result',
        success: true,
        adapter: rec.adapter,
        sender_id: rec.senderId,
        session_id: evt.session_id,
        error: 'already paired',
      });
      return;
    }
    createBinding(db, {
      sessionId: evt.session_id,
      adapter: rec.adapter,
      senderId: rec.senderId,
      ...(rec.senderMetadata ? { metadata: rec.senderMetadata } : {}),
    });
    consumePairCode(db, code);
    audit.write({
      kind: 'pair',
      session_id: evt.session_id,
      adapter: rec.adapter,
      sender_id: rec.senderId,
    });
    ipcServer.sendToSession(evt.session_id, {
      kind: 'admin_pair_result',
      success: true,
      adapter: rec.adapter,
      sender_id: rec.senderId,
      session_id: evt.session_id,
    });
    // Notify adapter
    const reg = adapters.get(rec.adapter);
    if (reg?.adapter.onPairingCompleted) {
      try {
        const payload: Parameters<NonNullable<typeof reg.adapter.onPairingCompleted>>[0] = {
          sessionId: evt.session_id,
          senderId: rec.senderId,
        };
        if (rec.senderMetadata) payload.metadata = rec.senderMetadata;
        const displayName = opts.config?.sessions.find((s) => s.session_id === evt.session_id)
          ?.display_name;
        if (displayName !== undefined) payload.displayName = displayName;
        await reg.adapter.onPairingCompleted(payload);
      } catch (err) {
        logger.warn(
          { err, adapter: rec.adapter, component: 'core.router' },
          'adapter onPairingCompleted threw',
        );
      }
    }
  }

  // Public API -----------------------------------------------------------------

  return {
    registerAdapter(name, reg) {
      adapters.set(name, reg);
    },
    unregisterAdapter(name) {
      adapters.delete(name);
    },
    permissions() {
      return permissions;
    },

    async ingestInbound(msg: InboundMessage): Promise<void> {
      const insertArgs: Parameters<typeof insertInbound>[1] = {
        session_id: msg.sessionId,
        adapter: msg.adapter,
        sender_id: msg.senderId,
        content: msg.content,
        meta: msg.meta,
        files: msg.files,
      };
      if (msg.correlationId !== undefined) insertArgs.correlation_id = msg.correlationId;
      if (msg.idempotencyKey !== undefined) insertArgs.idempotency_key = msg.idempotencyKey;
      const { message_id, inserted } = insertInbound(db, insertArgs);
      if (!inserted) {
        logger.debug(
          { message_id, idempotency_key: msg.idempotencyKey, component: 'core.router' },
          'duplicate inbound message ignored',
        );
        return;
      }
      lastInboundBySession.set(msg.sessionId, {
        adapter: msg.adapter,
        senderId: msg.senderId,
        messageId: message_id,
      });
      emit('inbound.persisted', {
        messageId: message_id,
        sessionId: msg.sessionId,
        adapter: msg.adapter,
        senderId: msg.senderId,
        content: msg.content,
        meta: msg.meta,
        files: msg.files,
        receivedAt: (msg.receivedAt instanceof Date
          ? msg.receivedAt
          : new Date()
        ).toISOString(),
      });
      await deliverInbound(msg.sessionId, message_id, msg.content, msg.meta);
    },

    async ingestPermissionVerdict(verdict: PermissionVerdict): Promise<void> {
      await permissions.handleVerdict(verdict);
    },

    isPaired(adapter, senderId, sessionId) {
      return isPairedDb(db, adapter, senderId, sessionId);
    },

    isSessionConnected(sessionId) {
      return ipcServer.isSessionConnected(sessionId);
    },

    listBindingsForSession(adapter, sessionId) {
      const rows = db
        .prepare(
          `SELECT sender_id, metadata, created_at FROM bindings
             WHERE adapter = ? AND session_id = ?
             ORDER BY rowid DESC`,
        )
        .all(adapter, sessionId) as Array<{
        sender_id: string;
        metadata: string | null;
        created_at: string;
      }>;
      return rows.map((r) => ({
        senderId: r.sender_id,
        metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
        createdAt: r.created_at,
      }));
    },

    createPairCode(input) {
      const record = createPairCodeRecord(db, {
        adapter: input.adapter,
        senderId: input.senderId,
        ...(input.metadata ? { senderMetadata: input.metadata } : {}),
      });
      return { code: record.code, expiresAt: record.expiresAt };
    },

    events,

    async stop(): Promise<void> {
      await permissions.stop();
      emitter.removeAllListeners();
    },
  };
}
