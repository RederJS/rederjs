export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    caption?: string;
    date: number;
    photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    voice?: { file_id: string; duration: number; mime_type?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number; username?: string };
    message?: { message_id: number; chat: { id: number } };
  };
  edited_message?: TelegramUpdate['message'];
}

export type ParseMode = 'MarkdownV2' | 'HTML' | undefined;

export interface SendMessageOptions {
  parse_mode?: ParseMode;
  reply_to_message_id?: number;
  reply_markup?: InlineKeyboardMarkup;
  disable_web_page_preview?: boolean;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface InputMediaPhoto {
  type: 'photo';
  /** Local path; transport reads bytes and uploads. */
  path: string;
  caption?: string;
  parse_mode?: ParseMode;
}

export interface SendPhotoOptions {
  caption?: string;
  parse_mode?: ParseMode;
}

export interface SendDocumentOptions {
  caption?: string;
  parse_mode?: ParseMode;
  filename?: string;
}

export interface TelegramTransport {
  init(): Promise<{ botId: number; botUsername: string }>;
  getUpdates(params: {
    offset: number;
    timeout: number;
    allowed_updates?: string[];
  }): Promise<TelegramUpdate[]>;
  sendMessage(
    chatId: number | string,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<{ message_id: number }>;
  editMessageReplyMarkup(
    chatId: number | string,
    messageId: number,
    markup?: InlineKeyboardMarkup,
  ): Promise<void>;
  editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  getFile(fileId: string): Promise<{ file_path: string }>;
  downloadFile(filePath: string): Promise<Buffer>;
  sendPhoto(
    chatId: number | string,
    path: string,
    opts?: SendPhotoOptions,
  ): Promise<{ message_id: number }>;
  sendDocument(
    chatId: number | string,
    path: string,
    opts?: SendDocumentOptions,
  ): Promise<{ message_id: number }>;
  sendMediaGroup(
    chatId: number | string,
    media: readonly InputMediaPhoto[],
  ): Promise<Array<{ message_id: number }>>;
}
