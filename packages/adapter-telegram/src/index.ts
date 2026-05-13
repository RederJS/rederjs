import type { Logger } from 'pino';
import {
  Adapter,
  type AdapterContext,
  type OutboundMessage,
  type PermissionPrompt,
  type SendResult,
} from '@rederjs/core/adapter';
import { RateLimiter } from '@rederjs/core/ratelimit';
import { deleteBindingsForSessionExceptSenders } from '@rederjs/core/pairing';
import { TelegramAdapterConfigSchema, type TelegramAdapterConfig } from './config.js';
import type { TelegramTransport } from './transport.js';
import { createGrammyTransport } from './grammy-transport.js';
import { normalizeUpdate } from './inbound.js';
import { renderToMarkdownV2, renderPlain } from './rendering.js';
import { splitMessage } from './splitting.js';
import {
  renderPermissionPrompt,
  parsePermissionCallback,
  type StoredPrompt,
} from './permission-prompt.js';
import {
  cacheInboundBlob,
  encodeAttachmentsMeta,
  decodeAttachmentsMeta,
  AttachmentError,
  PER_FILE_MAX_BYTES,
} from '@rederjs/core/media';
import { join } from 'node:path';
import { sendOutboundWithFiles } from './outbound-media.js';

export interface TelegramAdapterOptions {
  transportFactory?: (token: string) => TelegramTransport;
  rateLimitPerMinute?: number;
  pairAttemptsPerHour?: number;
}

interface BotRuntime {
  sessionId: string;
  transport: TelegramTransport;
  botId: number;
  botUsername: string;
  pollAbort: AbortController;
  stopped: boolean;
  allowGroups: boolean;
}

const OFFSET_KEY_PREFIX = 'offset:';

/**
 * Extract the originating chat type from any Telegram update shape we care
 * about (message, edited_message, channel_post, edited_channel_post,
 * callback_query.message). Returns null when no chat info is present, in
 * which case callers should fall through to normalizeUpdate's 'ignore' path.
 */
function extractChatType(update: {
  message?: { chat?: { type?: string } } | undefined;
  edited_message?: { chat?: { type?: string } } | undefined;
  channel_post?: { chat?: { type?: string } } | undefined;
  edited_channel_post?: { chat?: { type?: string } } | undefined;
  callback_query?: { message?: { chat?: { type?: string } } } | undefined;
}): string | null {
  const candidate =
    update.message?.chat?.type ??
    update.edited_message?.chat?.type ??
    update.channel_post?.chat?.type ??
    update.edited_channel_post?.chat?.type ??
    update.callback_query?.message?.chat?.type;
  return candidate ?? null;
}

export class TelegramAdapter extends Adapter {
  override readonly name = 'telegram';
  private ctx!: AdapterContext;
  private logger!: Logger;
  private config!: TelegramAdapterConfig;
  private bots: BotRuntime[] = [];
  private pollLoops: Array<Promise<void>> = [];
  private messageRateLimiter: RateLimiter;
  private pairRateLimiter: RateLimiter;

  constructor(private readonly opts: TelegramAdapterOptions = {}) {
    super();
    this.messageRateLimiter = new RateLimiter(opts.rateLimitPerMinute ?? 60, 60_000);
    this.pairRateLimiter = new RateLimiter(opts.pairAttemptsPerHour ?? 5, 3_600_000);
  }

  override async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    const parsed = TelegramAdapterConfigSchema.safeParse(ctx.config);
    if (!parsed.success) {
      throw new Error(`invalid telegram adapter config: ${parsed.error.message}`);
    }
    this.config = parsed.data;

    // Reconcile persisted bindings against the current allowlist. Bindings
    // created by previous runs (or earlier in this run) for senders that have
    // since been removed from `allowlist` must not survive — otherwise those
    // senders could still resolve outstanding state (notably permission-prompt
    // callbacks, which look up by binding rather than re-checking the
    // allowlist). This is the root-cause fix complementing the defense-in-
    // depth allowlist re-check in handleCallbackQuery.
    //
    // Only runs in `allowlist` mode. In `pairing` mode, bindings ARE the
    // source of truth and must not be purged here.
    if (this.config.mode === 'allowlist' && ctx.db) {
      for (const bot of this.config.bots) {
        const removed = deleteBindingsForSessionExceptSenders(ctx.db, {
          adapter: 'telegram',
          sessionId: bot.session_id,
          allowedSenderIds: this.config.allowlist,
        });
        if (removed > 0) {
          this.logger.info(
            { session_id: bot.session_id, removed, component: 'adapter.telegram' },
            'reconciled telegram bindings against allowlist',
          );
        }
      }
    }

    for (const bot of this.config.bots) {
      const token = this.resolveToken(bot);
      if (!token) {
        this.logger.error({ session_id: bot.session_id }, 'telegram bot has no token; skipping');
        continue;
      }
      const transport = this.opts.transportFactory
        ? this.opts.transportFactory(token)
        : createGrammyTransport({ token });
      const info = await transport.init();
      const runtime: BotRuntime = {
        sessionId: bot.session_id,
        transport,
        botId: info.botId,
        botUsername: info.botUsername,
        pollAbort: new AbortController(),
        stopped: false,
        allowGroups: bot.allow_groups,
      };
      this.bots.push(runtime);
      this.logger.info(
        { bot_username: info.botUsername, session_id: bot.session_id },
        'telegram bot connected',
      );
      this.pollLoops.push(this.runPollLoop(runtime));
    }
  }

  override async stop(): Promise<void> {
    for (const runtime of this.bots) {
      runtime.stopped = true;
      runtime.pollAbort.abort();
    }
    await Promise.allSettled(this.pollLoops);
    this.pollLoops = [];
    this.bots = [];
  }

  override async sendOutbound(msg: OutboundMessage): Promise<SendResult> {
    const runtime = this.bots.find((b) => b.sessionId === msg.sessionId);
    if (!runtime) {
      return {
        success: false,
        retriable: false,
        error: `no telegram bot configured for session '${msg.sessionId}'`,
      };
    }
    const chatId = Number(msg.recipient);
    if (!Number.isFinite(chatId)) {
      return {
        success: false,
        retriable: false,
        error: `invalid recipient '${msg.recipient}' — expected numeric chat_id`,
      };
    }

    // Files path: bypass markdown rendering, send native media.
    if (msg.files.length > 0) {
      const refs = decodeAttachmentsMeta(msg.meta['attachments']);
      if (refs.length === 0) {
        return {
          success: false,
          retriable: false,
          error: 'message has files but no meta.attachments — staging regression',
        };
      }
      const result = await sendOutboundWithFiles({
        transport: runtime.transport,
        chatId,
        content: msg.content,
        refs,
        mediaCachePrefix: join(this.ctx.dataDir, 'media', 'sessions', msg.sessionId),
      });
      return {
        success: result.success,
        retriable: result.retriable,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.firstMessageId !== undefined
          ? { transportMessageId: String(result.firstMessageId) }
          : {}),
      };
    }

    const rendered = this.config.rendering.markdown
      ? renderToMarkdownV2(msg.content)
      : renderPlain(msg.content);
    const chunks = splitMessage(rendered.text);

    let firstMsgId: number | undefined;
    let lastError: Error | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      try {
        const result = await runtime.transport.sendMessage(chatId, chunk, {
          parse_mode: rendered.parse_mode,
        });
        if (firstMsgId === undefined) firstMsgId = result.message_id;
      } catch (err) {
        lastError = err as Error;
        // Only retry with plain rendering if the error is a MarkdownV2 parse failure.
        if (rendered.parse_mode === 'MarkdownV2' && this.isMarkdownParseError(lastError)) {
          this.logger.warn(
            { err, chunk_index: i },
            'markdown parse rejected, retrying chunk as plain text',
          );
          try {
            const fallback = renderPlain(chunks[i]!);
            const result = await runtime.transport.sendMessage(chatId, fallback.text, {
              parse_mode: fallback.parse_mode,
            });
            if (firstMsgId === undefined) firstMsgId = result.message_id;
            continue;
          } catch (err2) {
            lastError = err2 as Error;
          }
        }
        const retriable = this.isRetriable(lastError);
        return {
          success: false,
          retriable,
          error: lastError?.message ?? 'send failed',
        };
      }
    }
    return {
      success: true,
      retriable: false,
      ...(firstMsgId !== undefined ? { transportMessageId: String(firstMsgId) } : {}),
    };
  }

  override async sendPermissionPrompt(prompt: PermissionPrompt): Promise<void> {
    const runtime = this.bots.find((b) => b.sessionId === prompt.sessionId);
    if (!runtime) return;

    // Look up the most recent binding (paired user) for this session on this adapter.
    // Use the first binding's metadata chat_id.
    const recipientChatId = this.findRecipientChatId(prompt.sessionId);
    if (recipientChatId === null) {
      this.logger.warn(
        {
          session_id: prompt.sessionId,
          request_id: prompt.requestId,
          component: 'adapter.telegram',
        },
        'no paired Telegram recipient for permission prompt; skipping',
      );
      return;
    }

    const rendered = renderPermissionPrompt(prompt);
    try {
      const sent = await runtime.transport.sendMessage(recipientChatId, rendered.text, {
        parse_mode: rendered.parse_mode,
        reply_markup: rendered.markup,
      });
      const stored: StoredPrompt = {
        chatId: recipientChatId,
        messageId: sent.message_id,
        requestId: prompt.requestId,
        sessionId: prompt.sessionId,
        toolName: prompt.toolName,
      };
      await this.ctx.storage.set(`perm:${prompt.requestId}`, JSON.stringify(stored));
    } catch (err) {
      this.logger.warn({ err, request_id: prompt.requestId }, 'failed to send permission prompt');
    }
  }

  override async cancelPermissionPrompt(requestId: string, finalVerdict?: string): Promise<void> {
    const runtime = this.bots[0];
    if (!runtime) return;
    const buf = await this.ctx.storage.get(`perm:${requestId}`);
    if (!buf) return;
    let stored: StoredPrompt;
    try {
      stored = JSON.parse(buf.toString('utf8')) as StoredPrompt;
    } catch {
      await this.ctx.storage.delete(`perm:${requestId}`);
      return;
    }

    const suffix = this.suffixFor(finalVerdict);
    const text = '🔒 Permission request (resolved)\n' + `Tool: ${stored.toolName}\n` + suffix;
    try {
      const botForSession = this.bots.find((b) => b.sessionId === stored.sessionId) ?? runtime;
      await botForSession.transport.editMessageText(stored.chatId, stored.messageId, text);
    } catch (err) {
      this.logger.debug({ err, request_id: requestId }, 'editMessageText failed on cancel');
    }
    await this.ctx.storage.delete(`perm:${requestId}`);
  }

  private suffixFor(v: string | undefined): string {
    switch (v) {
      case 'allow':
        return '✅ Allowed';
      case 'deny':
        return '❌ Denied';
      case 'timeout':
        return '⏰ Timed out — denied by default';
      case 'terminal':
        return 'ℹ️ Answered in Claude Code terminal';
      case 'persistent':
        return '✅ Auto-allowed (persistent approval)';
      default:
        return 'ℹ️ Resolved';
    }
  }

  private findRecipientChatId(sessionId: string): number | null {
    const bindings = this.ctx.router.listBindingsForSession('telegram', sessionId);
    if (bindings.length === 0) return null;
    // Prefer the most recent binding (index 0); fall back to chat_id in metadata,
    // else sender_id (private DMs only).
    const b = bindings[0]!;
    const chatIdFromMeta = (b.metadata?.['chat_id'] ?? null) as string | number | null;
    if (chatIdFromMeta !== null && chatIdFromMeta !== undefined) {
      const n = Number(chatIdFromMeta);
      if (Number.isFinite(n)) return n;
    }
    const n = Number(b.senderId);
    return Number.isFinite(n) ? n : null;
  }

  private isMarkdownParseError(err: Error | undefined): boolean {
    if (!err) return false;
    const msg = err.message.toLowerCase();
    return (
      msg.includes("can't parse") || msg.includes('parse entities') || msg.includes('bad request')
    );
  }

  private isRetriable(err: Error | undefined): boolean {
    if (!err) return false;
    const msg = err.message.toLowerCase();
    if (msg.includes('429') || msg.includes('rate')) return true;
    if (/5\d\d/.test(msg)) return true;
    if (msg.includes('etimedout') || msg.includes('econnreset') || msg.includes('network')) {
      return true;
    }
    return false;
  }

  private resolveToken(bot: TelegramAdapterConfig['bots'][number]): string | null {
    if (bot.token) return bot.token;
    if (bot.token_env) {
      const v = process.env[bot.token_env];
      if (!v) {
        this.logger.error(
          { token_env: bot.token_env, session_id: bot.session_id },
          'telegram bot token env var is not set',
        );
        return null;
      }
      return v;
    }
    return null;
  }

  private async readOffset(sessionId: string): Promise<number> {
    const buf = await this.ctx.storage.get(`${OFFSET_KEY_PREFIX}${sessionId}`);
    if (!buf) return 0;
    const parsed = Number(buf.toString('utf8'));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async writeOffset(sessionId: string, offset: number): Promise<void> {
    await this.ctx.storage.set(`${OFFSET_KEY_PREFIX}${sessionId}`, String(offset));
  }

  private async runPollLoop(runtime: BotRuntime): Promise<void> {
    const timeoutSeconds = this.config.long_poll_timeout_seconds;
    let consecutiveErrors = 0;
    while (!runtime.stopped) {
      try {
        const offset = await this.readOffset(runtime.sessionId);
        const updates = await runtime.transport.getUpdates({
          offset,
          timeout: timeoutSeconds,
          allowed_updates: ['message', 'callback_query', 'edited_message'],
        });
        consecutiveErrors = 0;
        for (const update of updates) {
          if (runtime.stopped) return;
          try {
            await this.handleUpdate(runtime, update);
          } catch (err) {
            this.logger.error({ err, update_id: update.update_id }, 'failed to handle update');
          }
          // Advance offset AFTER router ingest / DB commit (router.ingestInbound
          // already committed the row before returning).
          await this.writeOffset(runtime.sessionId, update.update_id + 1);
        }
      } catch (err) {
        consecutiveErrors++;
        const wait = Math.min(30_000, 500 * 2 ** Math.min(consecutiveErrors, 6));
        this.logger.warn(
          { err, session_id: runtime.sessionId, wait_ms: wait },
          'telegram getUpdates failed; retrying',
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  private async handleUpdate(
    runtime: BotRuntime,
    update: Parameters<TelegramTransport['getUpdates']>[0] extends unknown
      ? Awaited<ReturnType<TelegramTransport['getUpdates']>>[number]
      : never,
  ): Promise<void> {
    // Chat-type gate: when allow_groups is false (the safe default), drop any
    // update whose underlying chat is not 'private'. This covers groups,
    // supergroups, and channels — and applies to text messages, edits,
    // callback queries (group inline-keyboards), photos, documents, and
    // commands. Drop silently to avoid signalling configuration to attackers.
    if (!runtime.allowGroups) {
      const chatType = extractChatType(update);
      if (chatType !== null && chatType !== 'private') {
        return;
      }
    }

    const norm = normalizeUpdate(update, { sessionId: runtime.sessionId });

    switch (norm.kind) {
      case 'text': {
        if (!norm.inbound) return;
        await this.gateInboundAndIngest(runtime, norm.inbound);
        return;
      }
      case 'command': {
        if (!norm.command) return;
        await this.handleCommand(runtime, norm.command);
        return;
      }
      case 'voice': {
        if (!norm.voiceNote) return;
        try {
          await runtime.transport.sendMessage(
            norm.voiceNote.chatId,
            'Voice notes are not yet supported in this version of reder. ' +
              'Please type your message, or paste a transcript.',
          );
        } catch (err) {
          this.logger.warn({ err }, 'failed to send voice-not-supported reply');
        }
        return;
      }
      case 'callback_query': {
        if (!norm.callback) return;
        await this.handleCallbackQuery(runtime, norm.callback);
        return;
      }
      case 'photo': {
        if (!norm.imageFileId) return;
        await this.handlePhoto(runtime, norm.imageFileId);
        return;
      }
      case 'document': {
        if (!norm.documentFileId) return;
        await this.handleDocument(runtime, norm.documentFileId);
        return;
      }
      case 'ignore':
        return;
    }
  }

  private async handleCallbackQuery(
    runtime: BotRuntime,
    cbq: { id: string; data: string; senderId: string; chatId: number; messageId: number },
  ): Promise<void> {
    const parsed = parsePermissionCallback(cbq.data);
    if (!parsed) {
      try {
        await runtime.transport.answerCallbackQuery(cbq.id);
      } catch {
        // best-effort
      }
      return;
    }

    // Acknowledge the button press immediately (Telegram requires <15s).
    try {
      await runtime.transport.answerCallbackQuery(
        cbq.id,
        parsed.decision === 'deny' ? 'Denied' : 'Allowed',
      );
    } catch {
      // best-effort
    }

    // Only accept verdicts from paired senders.
    const allowed = this.ctx.router.isPaired('telegram', cbq.senderId, runtime.sessionId);
    if (!allowed) {
      this.logger.warn(
        { sender_id: cbq.senderId, session_id: runtime.sessionId, component: 'adapter.telegram' },
        'callback from unpaired sender; dropping',
      );
      return;
    }

    // Defense-in-depth: in allowlist mode, re-check the live allowlist before
    // honoring the verdict. A binding may have been created when the sender
    // WAS on the allowlist, but if the operator has since removed them, their
    // verdict must not resolve permission requests. Drop silently — we don't
    // want to leak the membership signal to a probing client.
    if (this.config.mode === 'allowlist' && !this.config.allowlist.includes(cbq.senderId)) {
      this.logger.warn(
        { sender_id: cbq.senderId, session_id: runtime.sessionId, component: 'adapter.telegram' },
        'callback from sender no longer on allowlist; dropping',
      );
      return;
    }

    const persistent = parsed.decision === 'always';
    const behavior: 'allow' | 'deny' = parsed.decision === 'deny' ? 'deny' : 'allow';

    await this.ctx.router.ingestPermissionVerdict({
      requestId: parsed.requestId,
      behavior,
      respondent: `telegram:${cbq.senderId}`,
      persistent,
    });
  }

  private async gateInboundAndIngest(
    runtime: BotRuntime,
    msg: import('@rederjs/core/adapter').InboundMessage,
  ): Promise<void> {
    // 1. Access control: allowlist mode short-circuits pair-code flow.
    if (this.config.mode === 'allowlist') {
      if (!this.config.allowlist.includes(msg.senderId)) {
        this.logger.debug(
          { sender_id: msg.senderId, session_id: msg.sessionId, component: 'adapter.telegram' },
          'allowlist: dropped unapproved sender',
        );
        return;
      }
      this.ensureAllowlistBinding(msg);
    } else {
      const paired = this.ctx.router.isPaired('telegram', msg.senderId, msg.sessionId);
      if (!paired) {
        // First contact from an unpaired sender → initiate pairing.
        await this.initiatePairing(runtime, msg);
        return;
      }
    }

    // 2. Rate limit.
    const rl = this.messageRateLimiter.check(`telegram:${msg.senderId}:${msg.sessionId}`);
    if (!rl.allowed) {
      this.logger.warn(
        { sender_id: msg.senderId, session_id: msg.sessionId, component: 'adapter.telegram' },
        'rate limit exceeded; dropping message',
      );
      const chatId = Number(msg.meta['chat_id']);
      if (Number.isFinite(chatId)) {
        const resetInS = Math.ceil((rl.resetInMs ?? 60_000) / 1000);
        try {
          await runtime.transport.sendMessage(
            chatId,
            `Rate limit: too many messages. Wait ~${resetInS}s before sending more.`,
          );
        } catch {
          // best-effort
        }
      }
      return;
    }

    // 3. Forward to router.
    await this.ctx.router.ingestInbound(msg);
  }

  private async initiatePairing(
    runtime: BotRuntime,
    msg: import('@rederjs/core/adapter').InboundMessage,
  ): Promise<void> {
    const chatId = Number(msg.meta['chat_id']);
    if (!Number.isFinite(chatId)) return;

    // Rate limit pair attempts per sender.
    const rl = this.pairRateLimiter.check(`telegram-pair:${msg.senderId}`);
    if (!rl.allowed) {
      try {
        await runtime.transport.sendMessage(
          chatId,
          'Too many pairing attempts. Please try again later.',
        );
      } catch {
        // best-effort
      }
      return;
    }

    const { code } = this.ctx.router.createPairCode({
      adapter: 'telegram',
      senderId: msg.senderId,
      metadata: {
        chat_id: String(chatId),
        session_id_target: runtime.sessionId,
        ...(msg.meta['username'] !== undefined ? { username: msg.meta['username'] } : {}),
      },
    });

    const text =
      `This Telegram account is not paired to a Claude Code session yet.\n\n` +
      `Your pairing code is: *${code}*\n\n` +
      `In the project directory where your Claude Code shim for session ` +
      `"${runtime.sessionId}" is registered, run:\n\n` +
      '`reder pair ' +
      code +
      '`\n\n' +
      `The code expires in 10 minutes.`;

    try {
      await runtime.transport.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
    } catch (err) {
      this.logger.warn({ err, chat_id: chatId }, 'failed to send pairing instructions');
      try {
        await runtime.transport.sendMessage(
          chatId,
          `Pairing code: ${code}. Run "reder pair ${code}" in your Claude Code session. Expires in 10 minutes.`,
        );
      } catch {
        // best-effort
      }
    }
  }

  private async handleCommand(
    runtime: BotRuntime,
    cmd: { name: string; args: string; senderId: string; chatId: number },
  ): Promise<void> {
    // Built-in commands. /pair is intentionally NOT accepted here — the
    // instructions direct users to run `reder pair` locally so that sender
    // identity is proven via local project access, not trust in Telegram input.
    if (cmd.name === 'start' || cmd.name === 'help') {
      try {
        await runtime.transport.sendMessage(
          cmd.chatId,
          `Reder Telegram channel for session "${runtime.sessionId}". ` +
            `Send any message to pair or talk to Claude Code.`,
        );
      } catch {
        // best-effort
      }
      return;
    }
    // Unknown command → treat as a normal text message (fall through to gate).
    const inbound: import('@rederjs/core/adapter').InboundMessage = {
      adapter: 'telegram',
      sessionId: runtime.sessionId,
      senderId: cmd.senderId,
      content: `/${cmd.name}${cmd.args ? ' ' + cmd.args : ''}`,
      meta: { chat_id: String(cmd.chatId), chat_type: 'private' },
      files: [],
      idempotencyKey: `telegram:${cmd.chatId}:cmd:${cmd.name}:${Date.now()}`,
      receivedAt: new Date(),
    };
    await this.gateInboundAndIngest(runtime, inbound);
  }

  private async handlePhoto(
    runtime: BotRuntime,
    info: { chatId: number; senderId: string; fileId: string; caption: string | undefined },
  ): Promise<void> {
    if (!(await this.passesAccessGate(runtime, info.senderId, info.chatId))) return;
    let bytes: Buffer;
    try {
      const meta = await runtime.transport.getFile(info.fileId);
      bytes = await runtime.transport.downloadFile(meta.file_path);
    } catch (err) {
      this.logger.warn({ err }, 'photo download failed');
      return;
    }
    if (bytes.length > PER_FILE_MAX_BYTES) {
      await this.replyTooLarge(runtime, info.chatId, bytes.length);
      return;
    }
    let ref;
    try {
      ref = await cacheInboundBlob({
        dataDir: this.ctx.dataDir,
        sessionId: runtime.sessionId,
        bytes,
        declaredMime: undefined,
        declaredName: undefined,
      });
    } catch (err) {
      if (err instanceof AttachmentError && err.code === 'mime_unrecognized') {
        try {
          await runtime.transport.sendMessage(
            info.chatId,
            "Sorry, I couldn't recognize that image. Send PNG, JPEG, GIF, or WebP.",
          );
        } catch {
          // best-effort
        }
        return;
      }
      this.logger.warn({ err }, 'photo cache failed');
      return;
    }
    const content = info.caption ?? '';
    await this.ctx.router.ingestInbound({
      adapter: 'telegram',
      sessionId: runtime.sessionId,
      senderId: info.senderId,
      content,
      meta: {
        chat_id: String(info.chatId),
        chat_type: 'private',
        attachments: encodeAttachmentsMeta([ref]),
      },
      files: [ref.path],
      idempotencyKey: `telegram:${info.chatId}:photo:${ref.sha256}`,
      receivedAt: new Date(),
    });
  }

  private async handleDocument(
    runtime: BotRuntime,
    info: {
      chatId: number;
      senderId: string;
      fileId: string;
      filename: string | undefined;
      mimeType: string | undefined;
      size: number | undefined;
      caption: string | undefined;
    },
  ): Promise<void> {
    if (!(await this.passesAccessGate(runtime, info.senderId, info.chatId))) return;
    if (info.size !== undefined && info.size > PER_FILE_MAX_BYTES) {
      await this.replyTooLarge(runtime, info.chatId, info.size);
      return;
    }
    let bytes: Buffer;
    try {
      const meta = await runtime.transport.getFile(info.fileId);
      bytes = await runtime.transport.downloadFile(meta.file_path);
    } catch (err) {
      this.logger.warn({ err }, 'document download failed');
      return;
    }
    let ref;
    try {
      ref = await cacheInboundBlob({
        dataDir: this.ctx.dataDir,
        sessionId: runtime.sessionId,
        bytes,
        declaredMime: info.mimeType,
        declaredName: info.filename,
      });
    } catch (err) {
      if (err instanceof AttachmentError) {
        if (err.code === 'mime_not_allowed' || err.code === 'mime_unrecognized') {
          try {
            await runtime.transport.sendMessage(
              info.chatId,
              'Sorry, that file type is not supported. Send PNG/JPEG/GIF/WebP, PDF, Markdown, or plain text.',
            );
          } catch {
            // best-effort
          }
          return;
        }
        if (err.code === 'too_large') {
          await this.replyTooLarge(runtime, info.chatId, bytes.length);
          return;
        }
      }
      this.logger.warn({ err }, 'document cache failed');
      return;
    }
    const content = info.caption ?? '';
    await this.ctx.router.ingestInbound({
      adapter: 'telegram',
      sessionId: runtime.sessionId,
      senderId: info.senderId,
      content,
      meta: {
        chat_id: String(info.chatId),
        chat_type: 'private',
        attachments: encodeAttachmentsMeta([ref]),
      },
      files: [ref.path],
      idempotencyKey: `telegram:${info.chatId}:doc:${ref.sha256}`,
      receivedAt: new Date(),
    });
  }

  private async replyTooLarge(runtime: BotRuntime, chatId: number, size: number): Promise<void> {
    try {
      await runtime.transport.sendMessage(
        chatId,
        `File too large: ${Math.round(size / 1024 / 1024)} MB (limit 20 MB).`,
      );
    } catch {
      // best-effort
    }
  }

  /**
   * Shared access check for binary-content paths (photos, documents) that
   * don't construct a full InboundMessage before gating. In pairing mode:
   * unpaired senders get a pair-code DM; in allowlist mode: unapproved
   * senders are silently dropped.
   */
  private async passesAccessGate(
    runtime: BotRuntime,
    senderId: string,
    chatId: number,
  ): Promise<boolean> {
    if (this.config.mode === 'allowlist') {
      if (!this.config.allowlist.includes(senderId)) {
        this.logger.debug(
          { sender_id: senderId, session_id: runtime.sessionId, component: 'adapter.telegram' },
          'allowlist: dropped unapproved sender',
        );
        return false;
      }
      this.ctx.router.upsertBinding({
        adapter: 'telegram',
        senderId,
        sessionId: runtime.sessionId,
        metadata: { chat_id: String(chatId) },
      });
      return true;
    }
    const paired = this.ctx.router.isPaired('telegram', senderId, runtime.sessionId);
    if (paired) return true;
    await this.initiatePairing(
      runtime,
      this.stubInboundForChat(chatId, senderId, runtime.sessionId),
    );
    return false;
  }

  /**
   * In allowlist mode, create the binding row on first contact so outbound
   * routing and permission prompts can find the chat. Metadata mirrors the
   * shape used by the pairing flow.
   */
  private ensureAllowlistBinding(msg: import('@rederjs/core/adapter').InboundMessage): void {
    const chatId = msg.meta['chat_id'];
    const username = msg.meta['username'];
    const metadata: Record<string, unknown> = {};
    if (chatId !== undefined) metadata['chat_id'] = chatId;
    if (username !== undefined) metadata['username'] = username;
    this.ctx.router.upsertBinding({
      adapter: 'telegram',
      senderId: msg.senderId,
      sessionId: msg.sessionId,
      metadata,
    });
  }

  private stubInboundForChat(
    chatId: number,
    senderId: string,
    sessionId: string,
  ): import('@rederjs/core/adapter').InboundMessage {
    return {
      adapter: 'telegram',
      sessionId,
      senderId,
      content: '',
      meta: { chat_id: String(chatId) },
      files: [],
      receivedAt: new Date(),
    };
  }

  override async onPairingCompleted(binding: {
    sessionId: string;
    senderId: string;
    displayName?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const runtime = this.bots.find((b) => b.sessionId === binding.sessionId);
    if (!runtime) return;
    const chatIdRaw = binding.metadata?.['chat_id'];
    const chatId = typeof chatIdRaw === 'string' ? Number(chatIdRaw) : Number(chatIdRaw);
    if (!Number.isFinite(chatId)) return;
    const label = binding.displayName ?? binding.sessionId;
    try {
      await runtime.transport.sendMessage(
        chatId,
        `✅ Paired to Claude Code session "${label}". You can chat normally now.`,
      );
    } catch (err) {
      this.logger.warn({ err }, 'failed to send pairing-success reply');
    }
  }
}

export default TelegramAdapter;
export { renderToMarkdownV2, splitMessage };
