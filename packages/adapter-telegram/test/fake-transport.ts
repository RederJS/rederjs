import type {
  SendMessageOptions,
  TelegramTransport,
  TelegramUpdate,
  InlineKeyboardMarkup,
} from '../src/transport.js';

export interface SentMessage {
  chatId: number | string;
  text: string;
  opts?: SendMessageOptions;
  message_id: number;
}

export interface EditedMessage {
  chatId: number | string;
  messageId: number;
  text?: string;
  markup?: InlineKeyboardMarkup | undefined;
  opts?: SendMessageOptions;
}

export interface FakeTransportOptions {
  botId?: number;
  botUsername?: string;
  longPollTick?: number;
}

export class FakeTelegramTransport implements TelegramTransport {
  private pendingUpdates: TelegramUpdate[] = [];
  private nextMessageId = 1000;
  private startedOffset = -1;
  public sent: SentMessage[] = [];
  public edits: EditedMessage[] = [];
  public callbackAnswers: Array<{ id: string; text?: string }> = [];
  public failures: Array<{ kind: 'send' | 'getUpdates'; error: Error; remaining: number }> = [];
  public simulatedDownUntil: number | null = null;
  public files: Map<string, { file_path: string; data: Buffer }> = new Map();

  constructor(private readonly opts: FakeTransportOptions = {}) {}

  enqueueUpdate(update: TelegramUpdate): void {
    this.pendingUpdates.push(update);
  }

  enqueueText(params: {
    update_id: number;
    chatId: number;
    senderId: number;
    text: string;
    username?: string;
    messageId?: number;
  }): void {
    this.enqueueUpdate({
      update_id: params.update_id,
      message: {
        message_id: params.messageId ?? this.nextMessageId++,
        chat: { id: params.chatId, type: 'private' },
        from: {
          id: params.senderId,
          ...(params.username !== undefined ? { username: params.username } : {}),
        },
        text: params.text,
        date: Math.floor(Date.now() / 1000),
      },
    });
  }

  enqueueCallbackQuery(params: {
    update_id: number;
    id: string;
    chatId: number;
    messageId: number;
    senderId: number;
    data: string;
  }): void {
    this.enqueueUpdate({
      update_id: params.update_id,
      callback_query: {
        id: params.id,
        data: params.data,
        from: { id: params.senderId },
        message: { message_id: params.messageId, chat: { id: params.chatId } },
      },
    });
  }

  goDown(forMs: number): void {
    this.simulatedDownUntil = Date.now() + forMs;
  }

  failNextSend(error: Error, count = 1): void {
    this.failures.push({ kind: 'send', error, remaining: count });
  }

  async init(): Promise<{ botId: number; botUsername: string }> {
    return { botId: this.opts.botId ?? 12345, botUsername: this.opts.botUsername ?? 'fake_bot' };
  }

  async getUpdates(params: {
    offset: number;
    timeout: number;
  }): Promise<TelegramUpdate[]> {
    if (this.simulatedDownUntil !== null && Date.now() < this.simulatedDownUntil) {
      throw new Error('ECONNRESET: simulated network drop');
    }
    if (this.simulatedDownUntil !== null && Date.now() >= this.simulatedDownUntil) {
      this.simulatedDownUntil = null;
    }
    const gufail = this.failures.find((f) => f.kind === 'getUpdates' && f.remaining > 0);
    if (gufail) {
      gufail.remaining--;
      throw gufail.error;
    }
    this.startedOffset = params.offset;
    // Return only updates with update_id >= offset.
    const picked = this.pendingUpdates.filter((u) => u.update_id >= params.offset);
    // Wait briefly to simulate long-poll (but don't block tests too long)
    await new Promise((r) => setTimeout(r, this.opts.longPollTick ?? 5));
    return picked;
  }

  async sendMessage(
    chatId: number | string,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<{ message_id: number }> {
    const failure = this.failures.find((f) => f.kind === 'send' && f.remaining > 0);
    if (failure) {
      failure.remaining--;
      throw failure.error;
    }
    const message_id = this.nextMessageId++;
    this.sent.push(
      opts !== undefined ? { chatId, text, message_id, opts } : { chatId, text, message_id },
    );
    return { message_id };
  }

  async editMessageReplyMarkup(
    chatId: number | string,
    messageId: number,
    markup?: InlineKeyboardMarkup,
  ): Promise<void> {
    this.edits.push({ chatId, messageId, markup });
  }

  async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<void> {
    this.edits.push(
      opts !== undefined ? { chatId, messageId, text, opts } : { chatId, messageId, text },
    );
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    this.callbackAnswers.push(text !== undefined ? { id, text } : { id });
  }

  async getFile(fileId: string): Promise<{ file_path: string }> {
    const f = this.files.get(fileId);
    if (!f) throw new Error(`fake transport: unknown file_id ${fileId}`);
    return { file_path: f.file_path };
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    for (const f of this.files.values()) {
      if (f.file_path === filePath) return f.data;
    }
    throw new Error(`fake transport: unknown file_path ${filePath}`);
  }

  get lastOffset(): number {
    return this.startedOffset;
  }
}
