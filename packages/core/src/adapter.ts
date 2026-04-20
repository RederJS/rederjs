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

export interface RouterHandle {
  ingestInbound(msg: InboundMessage): Promise<void>;
  ingestPermissionVerdict(verdict: PermissionVerdict): Promise<void>;
  isPaired(adapter: string, senderId: string, sessionId: string): boolean;
  listBindingsForSession(adapter: string, sessionId: string): AdapterBinding[];
  createPairCode(input: {
    adapter: string;
    senderId: string;
    metadata?: Record<string, unknown>;
  }): { code: string; expiresAt: string };
}

export interface AdapterContext {
  readonly logger: Logger;
  readonly config: unknown;
  readonly storage: AdapterStorage;
  readonly router: RouterHandle;
  readonly dataDir: string;
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
