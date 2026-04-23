import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
type ChannelEventListener = (msg: {
  kind: 'channel_event';
  message_id: string;
  content: string;
  meta: Record<string, string>;
}) => void;
type PermissionVerdictListener = (msg: {
  kind: 'permission_verdict';
  request_id: string;
  behavior: 'allow' | 'deny';
}) => void;

export interface ShimIpcClient {
  sendReply(input: {
    request_id: string;
    content: string;
    meta?: Record<string, string>;
    files?: readonly string[];
    in_reply_to?: string;
  }): Promise<{ success: boolean; error?: string }>;
  sendPermissionRequest(input: {
    request_id: string;
    tool_name: string;
    description: string;
    input_preview: string;
  }): boolean;
  sendChannelAck(messageId: string): boolean;
  on(event: 'channel_event', listener: ChannelEventListener): void;
  on(event: 'permission_verdict', listener: PermissionVerdictListener): void;
  off(event: 'channel_event', listener: ChannelEventListener): void;
  off(event: 'permission_verdict', listener: PermissionVerdictListener): void;
}

export interface ShimDeps {
  ipc: ShimIpcClient;
  shimVersion: string;
  logger?: { debug: (msg: string) => void; info: (msg: string) => void; error: (msg: string) => void };
}

export interface McpChannelServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  readonly server: Server;
}

const ReplyInputSchema = z
  .object({
    request_id: z.string().min(1),
    content: z.string().min(1),
    meta: z.record(z.string().regex(/^[A-Za-z0-9_]+$/), z.string()).optional(),
    files: z.array(z.string()).optional(),
    in_reply_to: z.string().optional(),
  })
  .strict();

const PermissionRequestNotificationSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

export function createMcpChannelServer(deps: ShimDeps): McpChannelServer {
  const { ipc, shimVersion } = deps;

  const server = new Server(
    { name: 'reder-shim', version: shimVersion },
    {
      capabilities: {
        tools: {},
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
      },
      instructions:
        'Messages wrapped in <channel source="reder">…</channel> come from the ' +
        'reder daemon — a user reading them in a browser dashboard, Telegram, or ' +
        'another adapter, NOT the local terminal. Plain text responses stay in ' +
        'this tmux session and never reach the sender.\n\n' +
        'To reply, call the `reply` MCP tool exposed by this server ' +
        '(`mcp__reder__reply` in tool-namespaced form). Pass a short `request_id` ' +
        '(a fresh 5-letter id per reply) and your reply as `content`. If the tool ' +
        'schema is deferred, load it first via ' +
        '`ToolSearch(query="select:mcp__reder__reply", max_results=1)`.\n\n' +
        'Do this for every inbound channel message that expects a response.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: 'reply',
        description:
          'Send a message back to the user on the channel that originated this conversation. Use this when you want to reply to the most recent incoming channel message.',
        inputSchema: {
          type: 'object',
          properties: {
            request_id: {
              type: 'string',
              description:
                'Correlation ID for this reply. Claude Code issues a fresh 5-letter id for each reply.',
            },
            content: {
              type: 'string',
              description: 'Plain text content of the reply. Markdown accepted (MarkdownV2 style).',
            },
            meta: {
              type: 'object',
              description: 'Optional structured metadata (string keys matching [A-Za-z0-9_]+).',
              additionalProperties: { type: 'string' },
            },
            files: {
              type: 'array',
              description: 'Absolute paths of files (images, docs) to attach.',
              items: { type: 'string' },
            },
            in_reply_to: {
              type: 'string',
              description:
                'Optional message_id to thread this reply to (transport-specific behavior).',
            },
          },
          required: ['request_id', 'content'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'reply') {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }],
      };
    }
    const parsed = ReplyInputSchema.safeParse(request.params.arguments);
    if (!parsed.success) {
      return {
        isError: true,
        content: [{ type: 'text', text: `invalid reply args: ${parsed.error.message}` }],
      };
    }
    const replyInput: Parameters<ShimIpcClient['sendReply']>[0] = {
      request_id: parsed.data.request_id,
      content: parsed.data.content,
    };
    if (parsed.data.meta !== undefined) replyInput.meta = parsed.data.meta;
    if (parsed.data.files !== undefined) replyInput.files = parsed.data.files;
    if (parsed.data.in_reply_to !== undefined) replyInput.in_reply_to = parsed.data.in_reply_to;
    const result = await ipc.sendReply(replyInput);
    if (!result.success) {
      return {
        isError: true,
        content: [{ type: 'text', text: result.error ?? 'reply send failed' }],
      };
    }
    return { content: [{ type: 'text', text: 'sent' }] };
  });

  server.setNotificationHandler(PermissionRequestNotificationSchema, async (notification) => {
    ipc.sendPermissionRequest({
      request_id: notification.params.request_id,
      tool_name: notification.params.tool_name,
      description: notification.params.description,
      input_preview: notification.params.input_preview,
    });
  });

  const onChannelEvent = (msg: {
    kind: 'channel_event';
    message_id: string;
    content: string;
    meta: Record<string, string>;
  }): void => {
    void server
      .notification({
        method: 'notifications/claude/channel',
        params: { content: msg.content, meta: msg.meta },
      })
      .then(() => {
        ipc.sendChannelAck(msg.message_id);
      })
      .catch((err) => {
        deps.logger?.error(`failed to send channel notification: ${(err as Error).message}`);
      });
  };

  const onPermissionVerdict = (msg: {
    kind: 'permission_verdict';
    request_id: string;
    behavior: 'allow' | 'deny';
  }): void => {
    void server
      .notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: msg.request_id, behavior: msg.behavior },
      })
      .catch((err) => {
        deps.logger?.error(`failed to send permission verdict: ${(err as Error).message}`);
      });
  };

  ipc.on('channel_event', onChannelEvent);
  ipc.on('permission_verdict', onPermissionVerdict);

  return {
    server,
    async connect(transport) {
      await server.connect(transport);
    },
    async close() {
      ipc.off('channel_event', onChannelEvent);
      ipc.off('permission_verdict', onPermissionVerdict);
      await server.close();
    },
  };
}
