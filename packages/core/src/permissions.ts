import { createHash, randomUUID } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { AuditLog } from './audit.js';
import type { PermissionPrompt, PermissionVerdict } from './adapter.js';

export interface PermissionAdapterBridge {
  send(adapterName: string, prompt: PermissionPrompt): Promise<void>;
  cancel(adapterName: string, requestId: string, finalVerdict?: string): Promise<void>;
  allNames(): string[];
}

export interface PermissionRequestInput {
  session_id: string;
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

export interface PermissionResolvedHook {
  (info: {
    requestId: string;
    sessionId: string;
    behavior: 'allow' | 'deny';
    respondent: string;
  }): void;
}

export interface PermissionManagerOptions {
  db: Db;
  adapters: PermissionAdapterBridge;
  logger: Logger;
  audit: AuditLog;
  timeoutSeconds: number;
  defaultOnTimeout: 'allow' | 'deny';
  dispatchVerdict: (sessionId: string, requestId: string, behavior: 'allow' | 'deny') => void;
  onResolved?: PermissionResolvedHook;
}

interface ActiveEntry {
  request_id: string;
  session_id: string;
  tool_name: string;
  input_preview: string;
  timer: NodeJS.Timeout;
  settled: boolean;
}

function canonicalSignature(toolName: string, inputPreview: string): string {
  return createHash('sha256').update(toolName).update('\0').update(inputPreview).digest('hex');
}

export class PermissionManager {
  private active = new Map<string, ActiveEntry>();

  constructor(private readonly opts: PermissionManagerOptions) {}

  async handleRequest(req: PermissionRequestInput): Promise<void> {
    const signature = canonicalSignature(req.tool_name, req.input_preview);

    // Persistent approval short-circuit.
    const preApproved = this.opts.db
      .prepare(
        'SELECT approval_id FROM persistent_approvals WHERE session_id = ? AND tool_name = ? AND input_signature = ?',
      )
      .get(req.session_id, req.tool_name, signature);
    if (preApproved) {
      this.persistRequest(req, 'allow', 'persistent');
      this.opts.audit.write({
        kind: 'permission_verdict',
        session_id: req.session_id,
        request_id: req.request_id,
        tool_name: req.tool_name,
        verdict: 'allow',
        respondent: 'persistent',
      });
      this.opts.dispatchVerdict(req.session_id, req.request_id, 'allow');
      this.opts.onResolved?.({
        requestId: req.request_id,
        sessionId: req.session_id,
        behavior: 'allow',
        respondent: 'persistent',
      });
      return;
    }

    const expiresAt = new Date(Date.now() + this.opts.timeoutSeconds * 1000);
    this.persistRequest(req, null, undefined, expiresAt);

    const timer = setTimeout(() => {
      void this.resolveTimeout(req.request_id);
    }, this.opts.timeoutSeconds * 1000);

    this.active.set(req.request_id, {
      request_id: req.request_id,
      session_id: req.session_id,
      tool_name: req.tool_name,
      input_preview: req.input_preview,
      timer,
      settled: false,
    });

    const prompt: PermissionPrompt = {
      requestId: req.request_id,
      sessionId: req.session_id,
      toolName: req.tool_name,
      description: req.description,
      inputPreview: req.input_preview,
      expiresAt,
    };

    for (const name of this.opts.adapters.allNames()) {
      try {
        await this.opts.adapters.send(name, prompt);
      } catch (err) {
        this.opts.logger.error(
          { err, adapter: name, request_id: req.request_id },
          'failed to dispatch permission prompt to adapter',
        );
      }
    }
  }

  async handleVerdict(verdict: PermissionVerdict): Promise<void> {
    const entry = this.active.get(verdict.requestId);
    if (!entry) {
      this.opts.logger.debug(
        { request_id: verdict.requestId },
        'verdict for unknown or already-resolved request; ignoring',
      );
      return;
    }
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);

    this.updateRequestResolution(verdict.requestId, verdict.behavior, verdict.respondent);

    if (verdict.persistent && verdict.behavior === 'allow') {
      const signature = canonicalSignature(entry.tool_name, entry.input_preview);
      this.opts.db
        .prepare(
          `INSERT OR IGNORE INTO persistent_approvals
             (approval_id, session_id, tool_name, input_signature, created_at, respondent)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          entry.session_id,
          entry.tool_name,
          signature,
          new Date().toISOString(),
          verdict.respondent,
        );
    }

    this.opts.audit.write({
      kind: 'permission_verdict',
      session_id: entry.session_id,
      request_id: verdict.requestId,
      tool_name: entry.tool_name,
      verdict: verdict.behavior,
      respondent: verdict.respondent,
    });

    this.opts.dispatchVerdict(entry.session_id, verdict.requestId, verdict.behavior);
    this.opts.onResolved?.({
      requestId: verdict.requestId,
      sessionId: entry.session_id,
      behavior: verdict.behavior,
      respondent: verdict.respondent,
    });

    for (const name of this.opts.adapters.allNames()) {
      try {
        await this.opts.adapters.cancel(name, verdict.requestId, verdict.behavior);
      } catch (err) {
        this.opts.logger.error(
          { err, adapter: name, request_id: verdict.requestId },
          'failed to cancel adapter permission prompt',
        );
      }
    }

    this.active.delete(verdict.requestId);
  }

  private async resolveTimeout(requestId: string): Promise<void> {
    const entry = this.active.get(requestId);
    if (!entry || entry.settled) return;
    entry.settled = true;

    const behavior = this.opts.defaultOnTimeout;
    this.updateRequestResolution(requestId, behavior, 'timeout');

    this.opts.audit.write({
      kind: 'permission_verdict',
      session_id: entry.session_id,
      request_id: requestId,
      tool_name: entry.tool_name,
      verdict: 'timeout',
    });

    this.opts.dispatchVerdict(entry.session_id, requestId, behavior);
    this.opts.onResolved?.({
      requestId,
      sessionId: entry.session_id,
      behavior,
      respondent: 'timeout',
    });

    for (const name of this.opts.adapters.allNames()) {
      try {
        await this.opts.adapters.cancel(name, requestId, 'timeout');
      } catch {
        // best-effort
      }
    }
    this.active.delete(requestId);
  }

  private persistRequest(
    req: PermissionRequestInput,
    verdict: 'allow' | 'deny' | null,
    respondent?: string,
    expiresAt?: Date,
  ): void {
    this.opts.db
      .prepare(
        `INSERT OR REPLACE INTO permission_requests
           (request_id, session_id, tool_name, tool_input, description,
            created_at, expires_at, resolved_at, verdict, respondent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.request_id,
        req.session_id,
        req.tool_name,
        req.input_preview,
        req.description,
        new Date().toISOString(),
        (expiresAt ?? new Date(Date.now() + this.opts.timeoutSeconds * 1000)).toISOString(),
        verdict !== null ? new Date().toISOString() : null,
        verdict,
        respondent ?? null,
      );
  }

  private updateRequestResolution(
    requestId: string,
    behavior: 'allow' | 'deny',
    respondent: string,
  ): void {
    this.opts.db
      .prepare(
        `UPDATE permission_requests
            SET resolved_at = ?, verdict = ?, respondent = ?
          WHERE request_id = ?`,
      )
      .run(new Date().toISOString(), behavior, respondent, requestId);
  }

  async stop(): Promise<void> {
    for (const entry of this.active.values()) {
      clearTimeout(entry.timer);
    }
    this.active.clear();
  }

  /**
   * Abandon every in-flight permission request belonging to a session — used
   * when the session's claude process has been cleared/restarted, so the
   * original tool calls are no longer reachable. Returns the request_ids
   * that were active so callers can broadcast cancellation to adapters.
   *
   * Adapter prompts are cancelled here with `final_verdict='terminal'` so
   * the user-visible UI in Telegram / web disappears. The on-disk
   * `permission_requests` rows are NOT updated — the surrounding session
   * purge deletes them.
   */
  async cancelForSession(sessionId: string): Promise<string[]> {
    const cancelled: string[] = [];
    for (const [requestId, entry] of this.active) {
      if (entry.session_id !== sessionId) continue;
      clearTimeout(entry.timer);
      entry.settled = true;
      cancelled.push(requestId);
    }
    for (const requestId of cancelled) {
      this.active.delete(requestId);
      for (const name of this.opts.adapters.allNames()) {
        try {
          await this.opts.adapters.cancel(name, requestId, 'terminal');
        } catch (err) {
          this.opts.logger.error(
            { err, adapter: name, request_id: requestId },
            'failed to cancel adapter permission prompt during session clear',
          );
        }
      }
    }
    return cancelled;
  }

  // Test helper
  activeCount(): number {
    return this.active.size;
  }
}
