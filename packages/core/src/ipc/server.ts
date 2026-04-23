import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Database as Db } from 'better-sqlite3';
import type { Logger } from 'pino';
import { encode, FrameDecoder, FrameTooLargeError } from './codec.js';
import {
  ShimToDaemon,
  DaemonToShim,
  PROTOCOL_VERSION,
  type ShimToDaemonMsg,
  type DaemonToShimMsg,
} from './protocol.js';
import { verifyToken, markConnected, markDisconnected } from '../sessions.js';

export interface CreateIpcServerOptions {
  db: Db;
  socketPath: string;
  logger: Logger;
  heartbeatTimeoutMs?: number;
}

interface ConnectionCtx {
  socket: Socket;
  decoder: FrameDecoder;
  sessionId: string | null;
  authenticated: boolean;
  heartbeatTimer: NodeJS.Timeout | null;
}

export type ReplyToolCallEvent = {
  session_id: string;
  request_id: string;
  content: string;
  meta: Record<string, string>;
  files: readonly string[];
  in_reply_to?: string;
};

export type PermissionRequestEvent = {
  session_id: string;
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
};

export type ChannelAckEvent = {
  session_id: string;
  message_id: string;
};

export type AdminPairRequestEvent = {
  session_id: string;
  code: string;
};

export type HookEventEvent = {
  session_id: string;
  hook: 'SessionStart' | 'UserPromptSubmit' | 'Stop' | 'SessionEnd';
  timestamp: string;
  payload?: Record<string, unknown>;
};

type IpcEvents = {
  shim_connected: (sessionId: string) => void;
  shim_disconnected: (sessionId: string) => void;
  reply_tool_call: (event: ReplyToolCallEvent) => void;
  permission_request: (event: PermissionRequestEvent) => void;
  channel_ack: (event: ChannelAckEvent) => void;
  admin_pair_request: (event: AdminPairRequestEvent) => void;
  hook_event: (event: HookEventEvent) => void;
};

export interface IpcServer {
  readonly socketPath: string;
  on<E extends keyof IpcEvents>(event: E, listener: IpcEvents[E]): void;
  off<E extends keyof IpcEvents>(event: E, listener: IpcEvents[E]): void;
  sendToSession(sessionId: string, msg: DaemonToShimMsg): boolean;
  isSessionConnected(sessionId: string): boolean;
  close(): Promise<void>;
}

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 12_000;

export async function createIpcServer(opts: CreateIpcServerOptions): Promise<IpcServer> {
  const { db, socketPath, logger } = opts;
  const heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;

  // Ensure parent dir exists with restrictive permissions.
  const parent = dirname(socketPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);

  // Remove any stale socket.
  try {
    unlinkSync(socketPath);
  } catch {
    // ignore ENOENT
  }

  const connections = new Map<string, ConnectionCtx>();
  const emitter = new EventEmitter() as EventEmitter & {
    on<E extends keyof IpcEvents>(event: E, listener: IpcEvents[E]): EventEmitter;
    off<E extends keyof IpcEvents>(event: E, listener: IpcEvents[E]): EventEmitter;
    emit<E extends keyof IpcEvents>(event: E, ...args: Parameters<IpcEvents[E]>): boolean;
  };

  function resetHeartbeat(ctx: ConnectionCtx): void {
    if (ctx.heartbeatTimer) clearTimeout(ctx.heartbeatTimer);
    ctx.heartbeatTimer = setTimeout(() => {
      logger.warn(
        { session_id: ctx.sessionId, component: 'ipc.server' },
        'heartbeat timeout; closing connection',
      );
      ctx.socket.destroy();
    }, heartbeatTimeoutMs);
  }

  function sendFrame(ctx: ConnectionCtx, msg: DaemonToShimMsg): boolean {
    if (ctx.socket.destroyed) return false;
    try {
      const buf = encode(msg);
      return ctx.socket.write(buf);
    } catch (err) {
      logger.error(
        { err, component: 'ipc.server' },
        'failed to encode/write frame',
      );
      return false;
    }
  }

  function teardownConnection(ctx: ConnectionCtx): void {
    if (ctx.heartbeatTimer) {
      clearTimeout(ctx.heartbeatTimer);
      ctx.heartbeatTimer = null;
    }
    if (ctx.sessionId && ctx.authenticated) {
      if (connections.get(ctx.sessionId) === ctx) {
        connections.delete(ctx.sessionId);
        markDisconnected(db, ctx.sessionId);
        emitter.emit('shim_disconnected', ctx.sessionId);
      }
    }
  }

  async function handleFrame(ctx: ConnectionCtx, raw: unknown): Promise<void> {
    const parseResult = ShimToDaemon.safeParse(raw);
    if (!parseResult.success) {
      logger.warn({ err: parseResult.error.message, component: 'ipc.server' }, 'invalid frame');
      sendFrame(ctx, { kind: 'error', code: 'INVALID_FRAME', message: parseResult.error.message });
      ctx.socket.destroy();
      return;
    }
    const msg: ShimToDaemonMsg = parseResult.data;

    if (!ctx.authenticated && msg.kind !== 'hello' && msg.kind !== 'hook_event') {
      sendFrame(ctx, {
        kind: 'error',
        code: 'UNAUTHENTICATED',
        message: 'expected hello or hook_event as first frame',
      });
      ctx.socket.destroy();
      return;
    }

    switch (msg.kind) {
      case 'hello': {
        const ok = await verifyToken(db, msg.session_id, msg.shim_token);
        if (!ok) {
          sendFrame(ctx, { kind: 'error', code: 'AUTH', message: 'invalid session_id or token' });
          ctx.socket.destroy();
          return;
        }
        // Displace any existing connection for this session.
        const prior = connections.get(msg.session_id);
        if (prior) {
          logger.info(
            { session_id: msg.session_id, component: 'ipc.server' },
            'displacing prior shim connection for session',
          );
          prior.socket.destroy();
        }
        ctx.sessionId = msg.session_id;
        ctx.authenticated = true;
        connections.set(msg.session_id, ctx);
        markConnected(db, msg.session_id);
        resetHeartbeat(ctx);
        sendFrame(ctx, {
          kind: 'welcome',
          session_id: msg.session_id,
          protocol_version: PROTOCOL_VERSION,
        });
        emitter.emit('shim_connected', msg.session_id);
        return;
      }
      case 'ping':
        resetHeartbeat(ctx);
        sendFrame(ctx, { kind: 'pong' });
        return;
      case 'reply_tool_call':
        resetHeartbeat(ctx);
        emitter.emit('reply_tool_call', {
          session_id: ctx.sessionId!,
          request_id: msg.request_id,
          content: msg.content,
          meta: msg.meta,
          files: msg.files,
          ...(msg.in_reply_to !== undefined ? { in_reply_to: msg.in_reply_to } : {}),
        });
        return;
      case 'permission_request':
        resetHeartbeat(ctx);
        emitter.emit('permission_request', {
          session_id: ctx.sessionId!,
          request_id: msg.request_id,
          tool_name: msg.tool_name,
          description: msg.description,
          input_preview: msg.input_preview,
        });
        return;
      case 'channel_ack':
        resetHeartbeat(ctx);
        emitter.emit('channel_ack', { session_id: ctx.sessionId!, message_id: msg.message_id });
        return;
      case 'admin_pair_request':
        resetHeartbeat(ctx);
        emitter.emit('admin_pair_request', { session_id: ctx.sessionId!, code: msg.code });
        return;
      case 'hook_event': {
        const ok = await verifyToken(db, msg.session_id, msg.shim_token);
        if (!ok) {
          sendFrame(ctx, { kind: 'error', code: 'AUTH', message: 'invalid session_id or token' });
          ctx.socket.destroy();
          return;
        }
        emitter.emit('hook_event', {
          session_id: msg.session_id,
          hook: msg.hook,
          timestamp: msg.timestamp,
          ...(msg.payload !== undefined ? { payload: msg.payload } : {}),
        });
        // One-shot: do not register the connection, do not mark session connected.
        // Just close the socket after a short drain window.
        ctx.socket.end();
        return;
      }
    }
  }

  function handleConnection(socket: Socket): void {
    const ctx: ConnectionCtx = {
      socket,
      decoder: new FrameDecoder(),
      sessionId: null,
      authenticated: false,
      heartbeatTimer: null,
    };

    socket.on('data', (chunk: Buffer) => {
      try {
        const frames = ctx.decoder.push(chunk);
        for (const frame of frames) {
          void handleFrame(ctx, frame);
        }
      } catch (err) {
        if (err instanceof FrameTooLargeError) {
          sendFrame(ctx, { kind: 'error', code: 'FRAME_TOO_LARGE', message: err.message });
        } else {
          logger.error({ err, component: 'ipc.server' }, 'decoder error');
        }
        ctx.socket.destroy();
      }
    });

    socket.on('close', () => teardownConnection(ctx));
    socket.on('error', (err) => {
      logger.debug({ err, session_id: ctx.sessionId, component: 'ipc.server' }, 'socket error');
    });
  }

  const server: Server = createServer(handleConnection);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  chmodSync(socketPath, 0o600);

  logger.info({ socketPath, component: 'ipc.server' }, 'ipc server listening');

  return {
    socketPath,
    on(event, listener) {
      emitter.on(event, listener as (...args: unknown[]) => void);
    },
    off(event, listener) {
      emitter.off(event, listener as (...args: unknown[]) => void);
    },
    sendToSession(sessionId, msg) {
      const ctx = connections.get(sessionId);
      if (!ctx) return false;
      return sendFrame(ctx, msg);
    },
    isSessionConnected(sessionId) {
      return connections.has(sessionId);
    },
    async close() {
      for (const ctx of connections.values()) {
        ctx.socket.destroy();
      }
      connections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(socketPath);
      } catch {
        // ignore
      }
    },
  };
}

// Re-export for callers
export { DaemonToShim };
