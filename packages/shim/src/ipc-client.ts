import { createConnection, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { encode, FrameDecoder, FrameTooLargeError } from '@rederjs/core/ipc/codec';
import {
  DaemonToShim,
  type DaemonToShimMsg,
  type ShimToDaemonMsg,
} from '@rederjs/core/ipc/protocol';

export type IpcClientStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface IpcClientOptions {
  socketPath: string;
  sessionId: string;
  token: string;
  shimVersion: string;
  claudeCodeVersion: string;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxRetryAttempts?: number;
  pingIntervalMs?: number;
}

export interface ReplyInput {
  request_id: string;
  content: string;
  meta?: Record<string, string>;
  files?: readonly string[];
  in_reply_to?: string;
}

export interface ReplyResult {
  success: boolean;
  error?: string;
}

type ChannelEventMsg = Extract<DaemonToShimMsg, { kind: 'channel_event' }>;
type PermissionVerdictMsg = Extract<DaemonToShimMsg, { kind: 'permission_verdict' }>;
type ErrorMsg = Extract<DaemonToShimMsg, { kind: 'error' }>;

type ClientEvents = {
  status: (status: IpcClientStatus) => void;
  channel_event: (msg: ChannelEventMsg) => void;
  permission_verdict: (msg: PermissionVerdictMsg) => void;
  error_frame: (msg: ErrorMsg) => void;
};

export class IpcClient {
  private socket: Socket | null = null;
  private decoder = new FrameDecoder();
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private currentDelayMs: number;
  private status: IpcClientStatus = 'idle';
  private shuttingDown = false;
  private pendingRequests = new Map<
    string,
    { resolve: (r: ReplyResult) => void; reject: (e: Error) => void; timeout: NodeJS.Timeout }
  >();
  private emitter = new EventEmitter();

  constructor(private opts: IpcClientOptions) {
    this.currentDelayMs = opts.initialRetryDelayMs ?? 100;
  }

  get isConnected(): boolean {
    return this.status === 'connected';
  }

  on<E extends keyof ClientEvents>(event: E, listener: ClientEvents[E]): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  off<E extends keyof ClientEvents>(event: E, listener: ClientEvents[E]): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  private setStatus(s: IpcClientStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emitter.emit('status', s);
  }

  async connect(): Promise<void> {
    this.shuttingDown = false;
    await this.attemptOnce();
    if (this.status !== 'connected') {
      throw new Error(`ipc client failed to connect to ${this.opts.socketPath}`);
    }
  }

  private attemptOnce(): Promise<void> {
    return new Promise((resolve) => {
      this.setStatus('connecting');
      const socket = createConnection({ path: this.opts.socketPath });
      this.socket = socket;
      this.decoder.reset();

      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      socket.once('connect', () => {
        this.sendRaw({
          kind: 'hello',
          session_id: this.opts.sessionId,
          shim_token: this.opts.token,
          shim_version: this.opts.shimVersion,
          claude_code_version: this.opts.claudeCodeVersion,
        });
      });

      socket.on('data', (chunk: Buffer) => {
        try {
          for (const frame of this.decoder.push(chunk)) {
            this.handleFrame(frame, settle);
          }
        } catch (err) {
          if (err instanceof FrameTooLargeError) {
            socket.destroy();
          }
        }
      });

      socket.on('close', () => {
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        this.socket = null;
        this.setStatus('disconnected');
        this.failPendingRequests('connection closed');
        settle();
        this.scheduleReconnectIfNeeded();
      });

      socket.on('error', () => {
        // swallow; 'close' will fire next
      });
    });
  }

  private handleFrame(raw: unknown, onReady: () => void): void {
    const parsed = DaemonToShim.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;
    switch (msg.kind) {
      case 'welcome':
        this.setStatus('connected');
        this.retryAttempt = 0;
        this.currentDelayMs = this.opts.initialRetryDelayMs ?? 100;
        this.startPing();
        onReady();
        return;
      case 'channel_event':
        this.emitter.emit('channel_event', msg);
        return;
      case 'permission_verdict':
        this.emitter.emit('permission_verdict', msg);
        return;
      case 'reply_tool_result': {
        const pending = this.pendingRequests.get(msg.request_id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msg.request_id);
          const result: ReplyResult = { success: msg.success };
          if (msg.error !== undefined) {
            result.error = msg.error;
          }
          pending.resolve(result);
        }
        return;
      }
      case 'error':
        this.emitter.emit('error_frame', msg);
        if (!this.isConnected) {
          // error during handshake; don't retry.
          this.shuttingDown = true;
          this.socket?.destroy();
        }
        return;
      case 'pong':
        return;
    }
  }

  private sendRaw(msg: ShimToDaemonMsg): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    try {
      return this.socket.write(encode(msg));
    } catch {
      return false;
    }
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const interval = this.opts.pingIntervalMs ?? 5000;
    this.pingTimer = setInterval(() => {
      this.sendRaw({ kind: 'ping' });
    }, interval);
  }

  private scheduleReconnectIfNeeded(): void {
    if (this.shuttingDown) return;
    const max = this.opts.maxRetryAttempts;
    if (max !== undefined && this.retryAttempt >= max) return;
    const delay = this.currentDelayMs;
    this.retryAttempt += 1;
    this.currentDelayMs = Math.min(this.currentDelayMs * 2, this.opts.maxRetryDelayMs ?? 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptOnce();
    }, delay);
  }

  sendChannelAck(messageId: string): boolean {
    return this.sendRaw({ kind: 'channel_ack', message_id: messageId });
  }

  sendPermissionRequest(input: {
    request_id: string;
    tool_name: string;
    description: string;
    input_preview: string;
  }): boolean {
    return this.sendRaw({ kind: 'permission_request', ...input });
  }

  sendReply(input: ReplyInput): Promise<ReplyResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(input.request_id);
        reject(new Error(`reply_tool_call timeout for ${input.request_id}`));
      }, 30_000);
      this.pendingRequests.set(input.request_id, { resolve, reject, timeout });
      const payload: ShimToDaemonMsg = {
        kind: 'reply_tool_call',
        request_id: input.request_id,
        content: input.content,
        meta: input.meta ?? {},
        files: [...(input.files ?? [])],
        ...(input.in_reply_to !== undefined ? { in_reply_to: input.in_reply_to } : {}),
      };
      const ok = this.sendRaw(payload);
      if (!ok) {
        clearTimeout(timeout);
        this.pendingRequests.delete(input.request_id);
        reject(new Error('socket not writable'));
      }
    });
  }

  private failPendingRequests(reason: string): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      this.setStatus('idle');
      return;
    }
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.end();
    });
    this.setStatus('idle');
  }
}
