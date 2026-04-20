import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

const MetaRecord = z.record(z.string().regex(/^[A-Za-z0-9_]+$/), z.string());

export const ShimToDaemon = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hello'),
    session_id: z.string().min(1),
    shim_token: z.string().min(1),
    shim_version: z.string().min(1),
    claude_code_version: z.string().min(1),
  }),
  z.object({
    kind: z.literal('reply_tool_call'),
    request_id: z.string().min(1),
    content: z.string(),
    meta: MetaRecord.default({}),
    files: z.array(z.string()).default([]),
    in_reply_to: z.string().optional(),
  }),
  z.object({
    kind: z.literal('permission_request'),
    request_id: z.string().min(1),
    tool_name: z.string().min(1),
    description: z.string(),
    input_preview: z.string(),
  }),
  z.object({
    kind: z.literal('channel_ack'),
    message_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('admin_pair_request'),
    code: z.string().min(1),
  }),
  z.object({ kind: z.literal('ping') }),
]);

export type ShimToDaemonMsg = z.infer<typeof ShimToDaemon>;

export const DaemonToShim = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('welcome'),
    session_id: z.string().min(1),
    protocol_version: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('channel_event'),
    message_id: z.string().min(1),
    content: z.string(),
    meta: MetaRecord,
  }),
  z.object({
    kind: z.literal('permission_verdict'),
    request_id: z.string().min(1),
    behavior: z.enum(['allow', 'deny']),
  }),
  z.object({
    kind: z.literal('reply_tool_result'),
    request_id: z.string().min(1),
    success: z.boolean(),
    error: z.string().optional(),
  }),
  z.object({
    kind: z.literal('error'),
    code: z.string().min(1),
    message: z.string(),
  }),
  z.object({
    kind: z.literal('admin_pair_result'),
    success: z.boolean(),
    adapter: z.string().optional(),
    sender_id: z.string().optional(),
    session_id: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({ kind: z.literal('pong') }),
]);

export type DaemonToShimMsg = z.infer<typeof DaemonToShim>;
