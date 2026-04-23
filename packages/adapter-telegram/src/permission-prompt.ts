import type { InlineKeyboardMarkup } from './transport.js';
import type { PermissionPrompt } from '@rederjs/core/adapter';

export interface RenderedPromptMessage {
  text: string;
  markup: InlineKeyboardMarkup;
  parse_mode: 'MarkdownV2';
}

const MDV2_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;
function esc(s: string): string {
  return s.replace(MDV2_RESERVED, '\\$&');
}

export function renderPermissionPrompt(prompt: PermissionPrompt): RenderedPromptMessage {
  const preview =
    prompt.inputPreview.length > 400
      ? prompt.inputPreview.slice(0, 400) + '…'
      : prompt.inputPreview;

  const text =
    `🔒 *Permission requested*\n\n` +
    `*Tool:* \`${esc(prompt.toolName)}\`\n` +
    `*Session:* \`${esc(prompt.sessionId)}\`\n\n` +
    (prompt.description ? `${esc(prompt.description)}\n\n` : '') +
    '```\n' +
    preview.replace(/[`\\]/g, '\\$&') +
    '\n```';

  const markup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: '✅ Allow', callback_data: `perm:${prompt.requestId}:allow` },
        { text: '❌ Deny', callback_data: `perm:${prompt.requestId}:deny` },
      ],
      [
        {
          text: `🔓 Always allow ${prompt.toolName}`,
          callback_data: `perm:${prompt.requestId}:always`,
        },
      ],
    ],
  };

  return { text, markup, parse_mode: 'MarkdownV2' };
}

export interface ParsedCallbackData {
  kind: 'permission';
  requestId: string;
  decision: 'allow' | 'deny' | 'always';
}

export function parsePermissionCallback(data: string): ParsedCallbackData | null {
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== 'perm') return null;
  const decision = parts[2];
  if (decision !== 'allow' && decision !== 'deny' && decision !== 'always') return null;
  return { kind: 'permission', requestId: parts[1]!, decision };
}

export interface StoredPrompt {
  chatId: number;
  messageId: number;
  requestId: string;
  sessionId: string;
  toolName: string;
}
