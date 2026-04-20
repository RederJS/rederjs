import { pino, type Logger, type DestinationStream, type LoggerOptions } from 'pino';

export const REDACTED_MARKER = '[REDACTED]';

const DEFAULT_REDACT_PATHS = [
  'token',
  'shim_token',
  'bot_token',
  'api_key',
  'message_body',
  'content.text',
  'tool_input',
  '*.token',
  '*.api_key',
  '*.shim_token',
  '*.bot_token',
  '*.message_body',
  '*.*.api_key',
  '*.*.token',
  '*.*.bot_token',
];

export interface CreateLoggerOptions {
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  destination?: DestinationStream;
  pretty?: boolean;
  extraRedactPaths?: readonly string[];
  bindings?: Record<string, unknown>;
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const { level = 'info', destination, extraRedactPaths = [], bindings } = opts;

  const options: LoggerOptions = {
    level,
    redact: {
      paths: [...DEFAULT_REDACT_PATHS, ...extraRedactPaths],
      censor: REDACTED_MARKER,
      remove: false,
    },
    base: bindings ?? null,
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return destination ? pino(options, destination) : pino(options);
}

export type { Logger } from 'pino';
