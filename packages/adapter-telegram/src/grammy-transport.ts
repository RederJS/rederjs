import { Bot, InputFile } from 'grammy';
import type { SendMessageOptions, TelegramTransport, TelegramUpdate } from './transport.js';

export interface GrammyTransportOptions {
  token: string;
}

export function createGrammyTransport(opts: GrammyTransportOptions): TelegramTransport {
  const bot = new Bot(opts.token);

  return {
    async init() {
      await bot.init();
      const me = bot.botInfo;
      return { botId: me.id, botUsername: me.username };
    },
    async getUpdates(params) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updates = await (bot.api as any).getUpdates({
        offset: params.offset,
        timeout: params.timeout,
        allowed_updates: params.allowed_updates ?? ['message', 'callback_query', 'edited_message'],
      });
      return updates as TelegramUpdate[];
    },
    async sendMessage(chatId, text, opts?: SendMessageOptions) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options: Record<string, any> = {};
      if (opts?.parse_mode) options['parse_mode'] = opts.parse_mode;
      if (opts?.reply_to_message_id !== undefined) {
        options['reply_to_message_id'] = opts.reply_to_message_id;
      }
      if (opts?.reply_markup) options['reply_markup'] = opts.reply_markup;
      const result = await bot.api.sendMessage(chatId as number, text, options);
      return { message_id: result.message_id };
    },
    async editMessageReplyMarkup(chatId, messageId, markup) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options: Record<string, any> = {};
      if (markup) options['reply_markup'] = markup;
      await bot.api.editMessageReplyMarkup(chatId as number, messageId, options);
    },
    async editMessageText(chatId, messageId, text, opts) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options: Record<string, any> = {};
      if (opts?.parse_mode) options['parse_mode'] = opts.parse_mode;
      if (opts?.reply_markup) options['reply_markup'] = opts.reply_markup;
      await bot.api.editMessageText(chatId as number, messageId, text, options);
    },
    async answerCallbackQuery(id, text?: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options: Record<string, any> = {};
      if (text !== undefined) options['text'] = text;
      await bot.api.answerCallbackQuery(id, options);
    },
    async getFile(fileId: string) {
      const file = await bot.api.getFile(fileId);
      if (!file.file_path) throw new Error(`telegram returned no file_path for ${fileId}`);
      return { file_path: file.file_path };
    },
    async downloadFile(filePath: string) {
      const url = `https://api.telegram.org/file/bot${opts.token}/${filePath}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`file download failed (path=${filePath}): ${res.status} ${res.statusText}`);
      }
      return Buffer.from(await res.arrayBuffer());
    },
    async sendPhoto(chatId, path, opts) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const o: Record<string, any> = {};
      if (opts?.caption) o['caption'] = opts.caption;
      if (opts?.parse_mode) o['parse_mode'] = opts.parse_mode;
      const result = await bot.api.sendPhoto(chatId as number, new InputFile(path), o);
      return { message_id: result.message_id };
    },
    async sendDocument(chatId, path, opts) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const o: Record<string, any> = {};
      if (opts?.caption) o['caption'] = opts.caption;
      if (opts?.parse_mode) o['parse_mode'] = opts.parse_mode;
      const file = opts?.filename ? new InputFile(path, opts.filename) : new InputFile(path);
      const result = await bot.api.sendDocument(chatId as number, file, o);
      return { message_id: result.message_id };
    },
    async sendMediaGroup(chatId, media) {
      const items = media.map((m) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const item: Record<string, any> = {
          type: 'photo',
          media: new InputFile(m.path),
        };
        if (m.caption) item['caption'] = m.caption;
        if (m.parse_mode) item['parse_mode'] = m.parse_mode;
        return item;
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = await bot.api.sendMediaGroup(chatId as number, items as any);
      return results.map((r) => ({ message_id: r.message_id }));
    },
  };
}
