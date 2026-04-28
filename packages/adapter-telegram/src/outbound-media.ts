import { resolve } from 'node:path';
import type { AttachmentRef } from '@rederjs/core/media';
import type { TelegramTransport, InputMediaPhoto } from './transport.js';

const TELEGRAM_CAPTION_MAX = 1024;

export interface SendOutboundWithFilesInput {
  transport: TelegramTransport;
  chatId: number | string;
  content: string;
  refs: readonly AttachmentRef[];
  /** Absolute path prefix that staged files MUST start with. Defense-in-depth. */
  mediaCachePrefix: string;
}

export interface SendOutboundWithFilesResult {
  success: boolean;
  retriable: boolean;
  error?: string;
  firstMessageId?: number;
}

export async function sendOutboundWithFiles(
  input: SendOutboundWithFilesInput,
): Promise<SendOutboundWithFilesResult> {
  const prefix = resolve(input.mediaCachePrefix) + '/';
  for (const r of input.refs) {
    const abs = resolve(r.path);
    if (!abs.startsWith(prefix)) {
      return {
        success: false,
        retriable: false,
        error: `attachment path outside media cache: ${r.path}`,
      };
    }
  }

  const caption = truncateCaption(input.content);
  const images = input.refs.filter((r) => r.kind === 'image');
  const docs = input.refs.filter((r) => r.kind === 'document');

  let firstMessageId: number | undefined;
  let captionConsumed = false;
  let anyDelivered = false;
  let lastError: string | undefined;
  let lastRetriable = false;

  if (images.length >= 2) {
    const media: InputMediaPhoto[] = images.map((r, i) => ({
      type: 'photo',
      path: r.path,
      ...(i === 0 && caption ? { caption } : {}),
    }));
    try {
      const out = await input.transport.sendMediaGroup(input.chatId, media);
      anyDelivered = true;
      captionConsumed = caption.length > 0;
      firstMessageId ??= out[0]?.message_id;
    } catch (err) {
      lastError = (err as Error).message;
      lastRetriable = isRetriable(lastError);
    }
  } else if (images.length === 1) {
    try {
      const out = await input.transport.sendPhoto(input.chatId, images[0]!.path, {
        ...(caption ? { caption } : {}),
      });
      anyDelivered = true;
      captionConsumed = caption.length > 0;
      firstMessageId ??= out.message_id;
    } catch (err) {
      lastError = (err as Error).message;
      lastRetriable = isRetriable(lastError);
    }
  }

  for (let i = 0; i < docs.length; i++) {
    const r = docs[i]!;
    const useCaption = caption && !captionConsumed && i === 0;
    try {
      const out = await input.transport.sendDocument(input.chatId, r.path, {
        ...(useCaption ? { caption } : {}),
        filename: r.name,
      });
      anyDelivered = true;
      if (useCaption) captionConsumed = true;
      firstMessageId ??= out.message_id;
    } catch (err) {
      lastError = (err as Error).message;
      lastRetriable = isRetriable(lastError);
    }
  }

  if (anyDelivered) {
    return {
      success: true,
      retriable: false,
      ...(firstMessageId !== undefined ? { firstMessageId } : {}),
    };
  }
  return {
    success: false,
    retriable: lastRetriable,
    error: lastError ?? 'no items delivered',
  };
}

function truncateCaption(s: string): string {
  if (s.length <= TELEGRAM_CAPTION_MAX) return s;
  return s.slice(0, TELEGRAM_CAPTION_MAX - 1) + '…';
}

function isRetriable(msg: string | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  if (m.includes('429') || m.includes('rate')) return true;
  if (/5\d\d/.test(m)) return true;
  if (m.includes('etimedout') || m.includes('econnreset') || m.includes('network')) {
    return true;
  }
  return false;
}
