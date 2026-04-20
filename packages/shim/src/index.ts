#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IpcClient } from './ipc-client.js';
import { createMcpChannelServer } from './mcp-server.js';

const VERSION = '0.1.0';

function die(msg: string): never {
  process.stderr.write(`reder-shim: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'session-id': { type: 'string' },
      token: { type: 'string' },
      socket: { type: 'string' },
      'claude-version': { type: 'string', default: 'unknown' },
    },
    strict: false,
  });

  if (!values['session-id']) die('missing --session-id');
  if (!values.token) die('missing --token');
  if (!values.socket) die('missing --socket');

  const ipc = new IpcClient({
    socketPath: values.socket as string,
    sessionId: values['session-id'] as string,
    token: values.token as string,
    shimVersion: VERSION,
    claudeCodeVersion: values['claude-version'] as string,
  });

  try {
    await ipc.connect();
  } catch (err) {
    die(`failed to connect to rederd at ${values.socket as string}: ${(err as Error).message}`);
  }

  const mcp = createMcpChannelServer({
    ipc,
    shimVersion: VERSION,
    logger: {
      debug: (m) => process.stderr.write(`[debug] ${m}\n`),
      info: (m) => process.stderr.write(`[info] ${m}\n`),
      error: (m) => process.stderr.write(`[error] ${m}\n`),
    },
  });

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`reder-shim: ${signal} received, shutting down\n`);
    await mcp.close().catch(() => {});
    await ipc.close().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.stdin.on('end', () => void shutdown('stdin EOF'));
}

main().catch((err) => {
  process.stderr.write(`reder-shim: fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
