import {
  pino,
  stdSerializers,
  stdTimeFunctions,
  type Logger,
  type DestinationStream,
  type LoggerOptions,
} from 'pino';

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

const TOKEN_PATTERN_BOT = /bot\d+:[A-Za-z0-9_-]+/g;
const TOKEN_PATTERN_RDR = /rdr_(?:web|sess|pair)_[A-Za-z0-9_-]+/g;

export function scrubTokens(input: string): string {
  return input
    .replace(TOKEN_PATTERN_BOT, 'bot<redacted>')
    .replace(TOKEN_PATTERN_RDR, 'rdr_<redacted>');
}

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
    timestamp: stdTimeFunctions.isoTime,
    serializers: {
      err: (err: Error) => {
        const serialized = stdSerializers.err(err) as Record<string, unknown>;
        if (typeof serialized['message'] === 'string') {
          serialized['message'] = scrubTokens(serialized['message']);
        }
        if (typeof serialized['stack'] === 'string') {
          serialized['stack'] = scrubTokens(serialized['stack']);
        }
        return serialized;
      },
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((arg) => (typeof arg === 'string' ? scrubTokens(arg) : arg));
        return method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
  };

  return destination ? pino(options, destination) : pino(options);
}

export type { Logger } from 'pino';
