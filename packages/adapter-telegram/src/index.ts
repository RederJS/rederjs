import type { Logger } from 'pino';
import {
  Adapter,
  type AdapterContext,
  type OutboundMessage,
  type PermissionPrompt,
  type SendResult,
} from '@reder/core/adapter';
import { TelegramAdapterConfigSchema, type TelegramAdapterConfig } from './config.js';
import type { TelegramTransport } from './transport.js';
import { createGrammyTransport } from './grammy-transport.js';
import { normalizeUpdate } from './inbound.js';
import { renderToMarkdownV2, renderPlain } from './rendering.js';
import { splitMessage } from './splitting.js';

export interface TelegramAdapterOptions {
  transportFactory?: (token: string) => TelegramTransport;
}

interface BotRuntime {
  sessionId: string;
  transport: TelegramTransport;
  botId: number;
  botUsername: string;
  pollAbort: AbortController;
  stopped: boolean;
}

const OFFSET_KEY_PREFIX = 'offset:';

export class TelegramAdapter extends Adapter {
  override readonly name = 'telegram';
  private ctx!: AdapterContext;
  private logger!: Logger;
  private config!: TelegramAdapterConfig;
  private bots: BotRuntime[] = [];
  private pollLoops: Array<Promise<void>> = [];

  constructor(private readonly opts: TelegramAdapterOptions = {}) {
    super();
  }

  override async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    const parsed = TelegramAdapterConfigSchema.safeParse(ctx.config);
    if (!parsed.success) {
      throw new Error(`invalid telegram adapter config: ${parsed.error.message}`);
    }
    this.config = parsed.data;

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

  override async sendPermissionPrompt(_prompt: PermissionPrompt): Promise<void> {
    // Implemented in Milestone 8.
  }

  override async cancelPermissionPrompt(_requestId: string, _finalVerdict?: string): Promise<void> {
    // Implemented in Milestone 8.
  }

  private isMarkdownParseError(err: Error | undefined): boolean {
    if (!err) return false;
    const msg = err.message.toLowerCase();
    return msg.includes("can't parse") || msg.includes('parse entities') || msg.includes('bad request');
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
            this.logger.error(
              { err, update_id: update.update_id },
              'failed to handle update',
            );
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
    const norm = normalizeUpdate(update, { sessionId: runtime.sessionId });
    switch (norm.kind) {
      case 'text': {
        if (!norm.inbound) return;
        await this.ctx.router.ingestInbound(norm.inbound);
        return;
      }
      case 'voice': {
        if (!norm.voiceNote) return;
        // Reject voice notes in v0.1 (STT deferred).
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
      case 'photo':
      case 'document':
      case 'command':
      case 'callback_query':
      case 'ignore':
        // Handled in later milestones (M7 pairing, M8 permissions, M9 media).
        return;
    }
  }
}

export default TelegramAdapter;
export { renderToMarkdownV2, splitMessage };
