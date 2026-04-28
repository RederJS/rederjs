import { appendFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type AuditEvent =
  | { kind: 'pair'; session_id: string; adapter: string; sender_id: string }
  | { kind: 'unpair'; session_id: string; adapter: string; sender_id: string }
  | {
      kind: 'permission_verdict';
      session_id: string;
      request_id: string;
      tool_name: string;
      verdict: 'allow' | 'deny' | 'timeout' | 'terminal';
      respondent?: string;
    }
  | { kind: 'adapter_start'; adapter: string; details?: Record<string, unknown> }
  | { kind: 'adapter_stop'; adapter: string; reason?: string }
  | { kind: 'dangerous_flag_usage'; flag: string; caller?: string }
  | { kind: 'config_change'; detail: string }
  | { kind: 'rate_limit_exceeded'; adapter: string; sender_id: string; session_id: string }
  | { kind: 'unknown_sender_dropped'; adapter: string; sender_id: string }
  | {
      kind: 'session_cleared';
      session_id: string;
      source: 'startup' | 'clear';
      counts: {
        inbound: number;
        outbound: number;
        permissions: number;
        transcriptOffsets: number;
      };
      cancelled_permissions: number;
    };

export interface AuditLog {
  write(event: AuditEvent): void;
  close(): void;
}

function dayStamp(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fileFor(dir: string, d: Date): string {
  return join(dir, `audit-${dayStamp(d)}.log`);
}

export function createAuditLog(runtimeDir: string): AuditLog {
  let currentPath: string | null = null;

  function ensureFile(path: string): void {
    if (currentPath === path) return;
    if (!existsSync(path)) {
      appendFileSync(path, '');
    }
    chmodSync(path, 0o600);
    currentPath = path;
  }

  return {
    write(event) {
      const now = new Date();
      const path = fileFor(runtimeDir, now);
      ensureFile(path);
      const record = { timestamp: now.toISOString(), ...event };
      appendFileSync(path, JSON.stringify(record) + '\n');
    },
    close() {
      currentPath = null;
    },
  };
}
