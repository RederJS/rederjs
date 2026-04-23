import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createMcpChannelServer, type ShimDeps } from '../src/mcp-server.js';
import { EventEmitter } from 'node:events';

class FakeIpcClient extends EventEmitter {
  public sentReplies: Array<{ request_id: string; content: string }> = [];
  public sentPermissionRequests: Array<{ request_id: string; tool_name: string }> = [];
  public sentChannelAcks: string[] = [];
  public replyResult: { success: boolean; error?: string } = { success: true };

  async sendReply(input: {
    request_id: string;
    content: string;
  }): Promise<{ success: boolean; error?: string }> {
    this.sentReplies.push({ request_id: input.request_id, content: input.content });
    return this.replyResult;
  }

  sendPermissionRequest(input: {
    request_id: string;
    tool_name: string;
    description: string;
    input_preview: string;
  }): boolean {
    this.sentPermissionRequests.push({
      request_id: input.request_id,
      tool_name: input.tool_name,
    });
    return true;
  }

  sendChannelAck(messageId: string): boolean {
    this.sentChannelAcks.push(messageId);
    return true;
  }
}

function setupServer(): {
  client: Client;
  ipc: FakeIpcClient;
  connected: Promise<void>;
} {
  const ipc = new FakeIpcClient();
  const deps: ShimDeps = {
    ipc: ipc as unknown as ShimDeps['ipc'],
    shimVersion: '0.1.0',
  };
  const server = createMcpChannelServer(deps);
  const [serverT, clientT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
  const connected = Promise.all([server.connect(serverT), client.connect(clientT)]).then(() => {});
  return { client, ipc, connected };
}

describe('mcp channel server', () => {
  it('advertises claude/channel and claude/channel/permission capabilities', async () => {
    const { client, connected } = setupServer();
    await connected;
    const caps = client.getServerCapabilities();
    expect(caps).toBeDefined();
    expect(caps?.experimental?.['claude/channel']).toEqual({});
    expect(caps?.experimental?.['claude/channel/permission']).toEqual({});
    expect(caps?.tools).toBeDefined();
  });

  it('lists the reply tool', async () => {
    const { client, connected } = setupServer();
    await connected;
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('reply');
  });

  it('invokes the reply tool and forwards to ipc', async () => {
    const { client, ipc, connected } = setupServer();
    await connected;
    const result = await client.callTool({
      name: 'reply',
      arguments: { request_id: 'r1', content: 'hello from claude' },
    });
    expect(ipc.sentReplies).toEqual([{ request_id: 'r1', content: 'hello from claude' }]);
    expect(result.isError).toBeFalsy();
  });

  it('surfaces reply tool error as isError', async () => {
    const { client, ipc, connected } = setupServer();
    await connected;
    ipc.replyResult = { success: false, error: 'telegram rate limit' };
    const result = await client.callTool({
      name: 'reply',
      arguments: { request_id: 'r2', content: 'retry please' },
    });
    expect(result.isError).toBe(true);
  });

  it('forwards channel_event ipc messages as notifications/claude/channel', async () => {
    const { client, ipc, connected } = setupServer();
    await connected;
    const received: Array<{ content: string; meta: Record<string, string> }> = [];
    const ChannelNotification = z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
    });
    client.setNotificationHandler(ChannelNotification, (notification) => {
      received.push({
        content: notification.params.content,
        meta: notification.params.meta ?? {},
      });
    });
    ipc.emit('channel_event', {
      kind: 'channel_event',
      message_id: 'm1',
      content: 'hi from user',
      meta: { chat_id: '42' },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([{ content: 'hi from user', meta: { chat_id: '42' } }]);
    expect(ipc.sentChannelAcks).toEqual(['m1']);
  });

  it('forwards permission_verdict as notifications/claude/channel/permission', async () => {
    const { client, ipc, connected } = setupServer();
    await connected;
    const verdicts: Array<{ request_id: string; behavior: string }> = [];
    const PermissionNotification = z.object({
      method: z.literal('notifications/claude/channel/permission'),
      params: z.object({
        request_id: z.string(),
        behavior: z.enum(['allow', 'deny']),
      }),
    });
    client.setNotificationHandler(PermissionNotification, (notification) => {
      verdicts.push({
        request_id: notification.params.request_id,
        behavior: notification.params.behavior,
      });
    });
    ipc.emit('permission_verdict', {
      kind: 'permission_verdict',
      request_id: 'req-abc',
      behavior: 'allow',
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(verdicts).toEqual([{ request_id: 'req-abc', behavior: 'allow' }]);
  });

  it('forwards client permission_request notification to ipc', async () => {
    const { client, ipc, connected } = setupServer();
    await connected;
    await client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: {
        request_id: 'rqxyz',
        tool_name: 'Bash',
        description: 'Run tests',
        input_preview: '{"command":"npm test"}',
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(ipc.sentPermissionRequests).toEqual([{ request_id: 'rqxyz', tool_name: 'Bash' }]);
  });
});
