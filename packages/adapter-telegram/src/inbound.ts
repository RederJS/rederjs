import type { InboundMessage } from '@reder/core/adapter';
import type { TelegramUpdate } from './transport.js';

export interface NormalizeContext {
  sessionId: string;
}

export interface NormalizedUpdate {
  kind: 'text' | 'photo' | 'document' | 'voice' | 'command' | 'callback_query' | 'ignore';
  update_id: number;
  inbound?: InboundMessage;
  command?: { name: string; args: string; senderId: string; chatId: number };
  callback?: { id: string; data: string; senderId: string; chatId: number; messageId: number };
  voiceNote?: { chatId: number; senderId: string; fileId: string };
  imageFileId?: { chatId: number; senderId: string; fileId: string; caption: string | undefined };
  documentFileId?: {
    chatId: number;
    senderId: string;
    fileId: string;
    filename: string | undefined;
    mimeType: string | undefined;
    size: number | undefined;
    caption: string | undefined;
  };
}

export function normalizeUpdate(update: TelegramUpdate, ctx: NormalizeContext): NormalizedUpdate {
  if (update.callback_query) {
    const cbq = update.callback_query;
    if (cbq.message && cbq.data !== undefined) {
      return {
        kind: 'callback_query',
        update_id: update.update_id,
        callback: {
          id: cbq.id,
          data: cbq.data,
          senderId: String(cbq.from.id),
          chatId: cbq.message.chat.id,
          messageId: cbq.message.message_id,
        },
      };
    }
    return { kind: 'ignore', update_id: update.update_id };
  }

  const msg = update.message ?? update.edited_message;
  if (!msg || !msg.from) return { kind: 'ignore', update_id: update.update_id };
  const senderId = String(msg.from.id);
  const chatId = msg.chat.id;

  if (msg.text !== undefined) {
    // Command: /name [args]
    const trimmed = msg.text.trim();
    if (trimmed.startsWith('/')) {
      const spaceIdx = trimmed.indexOf(' ');
      const nameAndHost = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
      const name = nameAndHost.split('@')[0]!.toLowerCase();
      const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
      return {
        kind: 'command',
        update_id: update.update_id,
        command: { name, args, senderId, chatId },
      };
    }
    const inbound: InboundMessage = {
      adapter: 'telegram',
      sessionId: ctx.sessionId,
      senderId,
      content: msg.text,
      meta: {
        chat_id: String(chatId),
        chat_type: msg.chat.type,
        message_id: String(msg.message_id),
        ts: String(msg.date),
        ...(msg.from.username ? { username: msg.from.username } : {}),
      },
      files: [],
      idempotencyKey: `telegram:${chatId}:${msg.message_id}`,
      receivedAt: new Date(msg.date * 1000),
    };
    return { kind: 'text', update_id: update.update_id, inbound };
  }

  if (msg.photo && msg.photo.length > 0) {
    // Pick the largest size.
    const largest = msg.photo.reduce((a, b) =>
      (a.file_size ?? a.width * a.height) > (b.file_size ?? b.width * b.height) ? a : b,
    );
    const caption = msg.caption;
    return {
      kind: 'photo',
      update_id: update.update_id,
      imageFileId: {
        chatId,
        senderId,
        fileId: largest.file_id,
        caption,
      },
    };
  }

  if (msg.document) {
    return {
      kind: 'document',
      update_id: update.update_id,
      documentFileId: {
        chatId,
        senderId,
        fileId: msg.document.file_id,
        filename: msg.document.file_name,
        mimeType: msg.document.mime_type,
        size: msg.document.file_size,
        caption: msg.caption,
      },
    };
  }

  if (msg.voice) {
    return {
      kind: 'voice',
      update_id: update.update_id,
      voiceNote: { chatId, senderId, fileId: msg.voice.file_id },
    };
  }

  return { kind: 'ignore', update_id: update.update_id };
}
