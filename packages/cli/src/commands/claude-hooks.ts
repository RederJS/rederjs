import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const HOOKED_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'] as const;
type HookedEvent = (typeof HOOKED_EVENTS)[number];

export interface HookInstallParams {
  projectDir: string;
  sessionId: string;
  hookCommand: string; // e.g. "reder-hook" or absolute path
  socketPath: string;
  token: string;
}

export interface HookRemoveParams {
  projectDir: string;
  sessionId: string;
}

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: 'command'; command: string }>;
  _reder_session_id?: string;
}

interface SettingsShape {
  hooks?: Partial<Record<HookedEvent | string, HookEntry[]>>;
  [k: string]: unknown;
}

function settingsFile(projectDir: string): string {
  return join(projectDir, '.claude', 'settings.local.json');
}

function loadSettings(path: string): SettingsShape {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SettingsShape;
    }
  } catch {
    // fall through
  }
  throw new Error(`${path} exists but is not valid JSON; refusing to overwrite`);
}

function saveSettings(path: string, doc: SettingsShape): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

function buildCommand(p: HookInstallParams, event: HookedEvent): string {
  // Safe quoting: the command is rendered into JSON which Claude Code then
  // runs via a shell. Escape double quotes in paths defensively.
  const q = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;
  return [
    q(p.hookCommand),
    '--session-id',
    q(p.sessionId),
    '--socket',
    q(p.socketPath),
    '--token',
    q(p.token),
    '--hook',
    event,
  ].join(' ');
}

function makeEntry(event: HookedEvent, p: HookInstallParams): HookEntry {
  return {
    matcher: '*',
    hooks: [{ type: 'command', command: buildCommand(p, event) }],
    _reder_session_id: p.sessionId,
  };
}

function isOurs(entry: HookEntry, sessionId: string): boolean {
  return entry._reder_session_id === sessionId;
}

export function installClaudeHooks(p: HookInstallParams): void {
  const path = settingsFile(p.projectDir);
  const doc = loadSettings(path);
  if (!doc.hooks) doc.hooks = {};

  for (const event of HOOKED_EVENTS) {
    const list = (doc.hooks[event] ?? []) as HookEntry[];
    const filtered = list.filter((e) => !isOurs(e, p.sessionId));
    filtered.push(makeEntry(event, p));
    doc.hooks[event] = filtered;
  }

  saveSettings(path, doc);
}

export function removeClaudeHooks(p: HookRemoveParams): void {
  const path = settingsFile(p.projectDir);
  if (!existsSync(path)) return;
  const doc = loadSettings(path);
  if (!doc.hooks) return;

  for (const event of Object.keys(doc.hooks)) {
    const list = (doc.hooks[event] ?? []) as HookEntry[];
    const kept = list.filter((e) => !isOurs(e, p.sessionId));
    if (kept.length === 0) {
      delete doc.hooks[event];
    } else {
      doc.hooks[event] = kept;
    }
  }

  if (doc.hooks && Object.keys(doc.hooks).length === 0) {
    delete doc.hooks;
  }

  if (Object.keys(doc).length === 0) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
    return;
  }

  saveSettings(path, doc);
}

export function hasClaudeHooks(p: HookRemoveParams): boolean {
  const path = settingsFile(p.projectDir);
  if (!existsSync(path)) return false;
  const doc = loadSettings(path);
  if (!doc.hooks) return false;
  for (const event of HOOKED_EVENTS) {
    const list = (doc.hooks[event] ?? []) as HookEntry[];
    if (list.some((e) => isOurs(e, p.sessionId))) return true;
  }
  return false;
}

export function claudeSettingsPath(projectDir: string): string {
  return settingsFile(projectDir);
}
