import type { Database as Db } from 'better-sqlite3';
import type { Logger } from 'pino';

export interface AdapterStorage {
  get(key: string): Promise<Buffer | null>;
  set(key: string, value: Buffer | string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface AdapterBinding {
  senderId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface InboundPersistedPayload {
  readonly messageId: string;
  readonly sessionId: string;
  readonly adapter: string;
  readonly senderId: string;
  readonly content: string;
  readonly meta: Record<string, string>;
  readonly files: readonly string[];
  readonly receivedAt: string;
}

export interface OutboundPersistedPayload {
  readonly messageId: string;
  readonly sessionId: string;
  readonly adapter: string;
  readonly recipient: string;
  readonly content: string;
  readonly meta: Record<string, string>;
  readonly files: readonly string[];
  readonly createdAt: string;
}

export interface OutboundSentPayload extends OutboundPersistedPayload {
  readonly sentAt: string;
  readonly transportMessageId?: string;
}

export interface PermissionRequestedPayload {
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputPreview: string;
  readonly expiresAt: string;
}

export interface PermissionResolvedPayload {
  readonly requestId: string;
  readonly sessionId: string;
  readonly behavior: 'allow' | 'deny';
  readonly respondent: string;
}

export interface SessionStateChangedPayload {
  readonly sessionId: string;
  readonly state: 'registered' | 'connected' | 'disconnected' | 'revoked';
}

export type SessionActivityState = 'working' | 'awaiting-user' | 'idle' | 'unknown' | 'offline';

export interface SessionActivityChangedPayload {
  readonly sessionId: string;
  readonly state: SessionActivityState;
  readonly since: string;
  readonly lastHook?: 'SessionStart' | 'UserPromptSubmit' | 'Stop' | 'SessionEnd';
  readonly lastHookAt?: string;
}

export interface SessionClearedPayload {
  readonly sessionId: string;
  readonly source: 'startup' | 'clear';
  readonly clearedAt: string;
  readonly counts: {
    readonly inbound: number;
    readonly outbound: number;
    readonly permissions: number;
    readonly transcriptOffsets: number;
    readonly cancelledPermissions: number;
    readonly mediaWiped: boolean;
  };
}

export interface RouterEventMap {
  'inbound.persisted': InboundPersistedPayload;
  'outbound.persisted': OutboundPersistedPayload;
  'outbound.sent': OutboundSentPayload;
  'permission.requested': PermissionRequestedPayload;
  'permission.resolved': PermissionResolvedPayload;
  'session.state_changed': SessionStateChangedPayload;
  'session.activity_changed': SessionActivityChangedPayload;
  'session.cleared': SessionClearedPayload;
}

export interface RouterEvents {
  on<K extends keyof RouterEventMap>(
    event: K,
    listener: (payload: RouterEventMap[K]) => void,
  ): void;
  off<K extends keyof RouterEventMap>(
    event: K,
    listener: (payload: RouterEventMap[K]) => void,
  ): void;
}

export interface RouterHandle {
  ingestInbound(msg: InboundMessage): Promise<void>;
  ingestPermissionVerdict(verdict: PermissionVerdict): Promise<void>;
  isPaired(adapter: string, senderId: string, sessionId: string): boolean;
  isSessionConnected(sessionId: string): boolean;
  listBindingsForSession(adapter: string, sessionId: string): AdapterBinding[];
  createPairCode(input: {
    adapter: string;
    senderId: string;
    metadata?: Record<string, unknown>;
  }): { code: string; expiresAt: string };
  /**
   * Create the (adapter, senderId, sessionId) binding if it doesn't exist yet,
   * or refresh its metadata if it does. Intended for pre-approved flows like
   * a global allowlist where no pair-code exchange happens.
   */
  upsertBinding(input: {
    adapter: string;
    senderId: string;
    sessionId: string;
    metadata?: Record<string, unknown>;
  }): void;
  /** Inform the router that an adapter's unread count for a session changed. */
  notifyUnread(sessionId: string, unread: number): void;
  /** Current activity snapshots for every session the router knows about. */
  listActivity(): SessionActivityChangedPayload[];
  /** Current activity snapshot for a single session, or undefined if untracked. */
  getActivity(sessionId: string): SessionActivityChangedPayload | undefined;
  readonly events: RouterEvents;
}

export interface SessionDescriptor {
  readonly session_id: string;
  readonly display_name: string;
  readonly workspace_dir?: string;
  readonly avatar_path?: string;
  readonly auto_start: boolean;
}

export interface AdapterContext {
  readonly logger: Logger;
  readonly config: unknown;
  readonly storage: AdapterStorage;
  readonly router: RouterHandle;
  readonly dataDir: string;
  readonly sessions: readonly SessionDescriptor[];
  /**
   * Direct handle to the shared SQLite database. Available to in-process
   * adapters that need read access beyond what RouterHandle exposes (e.g. the
   * web dashboard querying transcript history). Third-party adapters can
   * ignore it.
   */
  readonly db?: Db;
  /**
   * Pre-built health snapshot function — returns the same JSON shape as the
   * daemon's `/health` endpoint. Used by the web adapter to serve `/health`.
   */
  readonly healthSnapshot?: () => Promise<unknown>;
}

export interface InboundMessage {
  readonly adapter: string;
  readonly sessionId: string;
  readonly senderId: string;
  readonly content: string;
  readonly meta: Record<string, string>;
  readonly files: readonly string[];
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly receivedAt: Date;
}

export interface OutboundMessage {
  readonly sessionId: string;
  readonly adapter: string;
  readonly recipient: string;
  readonly content: string;
  readonly meta: Record<string, string>;
  readonly files: readonly string[];
  readonly correlationId?: string;
  readonly inReplyTo?: string;
}

export interface PermissionPrompt {
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputPreview: string;
  readonly expiresAt: Date;
}

export interface PermissionVerdict {
  readonly requestId: string;
  readonly behavior: 'allow' | 'deny';
  readonly respondent: string;
  readonly persistent?: boolean;
}

export interface SendResult {
  readonly success: boolean;
  readonly transportMessageId?: string;
  readonly retriable: boolean;
  readonly error?: string;
}

export interface AdapterHealth {
  readonly healthy: boolean;
  readonly connectedSince?: Date;
  readonly lastInboundAt?: Date;
  readonly lastOutboundAt?: Date;
  readonly details: Record<string, unknown>;
}

export abstract class Adapter {
  abstract readonly name: string;
  abstract start(ctx: AdapterContext): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendOutbound(msg: OutboundMessage): Promise<SendResult>;
  abstract sendPermissionPrompt(prompt: PermissionPrompt): Promise<void>;
  abstract cancelPermissionPrompt(requestId: string, finalVerdict?: string): Promise<void>;

  healthCheck?(): Promise<AdapterHealth>;

  /**
   * Called when a pair code the adapter generated is successfully redeemed,
   * so the adapter can notify the end user (e.g. via DM "✅ paired").
   */
  onPairingCompleted?(binding: {
    sessionId: string;
    senderId: string;
    displayName?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}
