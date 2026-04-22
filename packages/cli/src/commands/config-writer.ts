import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseDocument, Document, YAMLMap, YAMLSeq, isScalar } from 'yaml';
import { defaultRuntimeDir, defaultDataDir } from '../paths.js';

export interface ScaffoldOptions {
  configPath: string;
  envPath: string;
  webBind: string;
  webPort: number;
}

export interface ScaffoldResult {
  configPath: string;
  envPath: string;
  created: boolean;
}

export function scaffoldConfig(opts: ScaffoldOptions): ScaffoldResult {
  const { configPath, envPath, webBind, webPort } = opts;

  if (existsSync(configPath)) {
    return { configPath, envPath, created: false };
  }

  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(dirname(envPath), { recursive: true });
  mkdirSync(defaultRuntimeDir(), { recursive: true, mode: 0o700 });
  mkdirSync(defaultDataDir(), { recursive: true, mode: 0o700 });

  const yaml = `version: 1

runtime:
  runtime_dir: ${defaultRuntimeDir()}
  data_dir: ${defaultDataDir()}

logging:
  level: info

health:
  enabled: true
  bind: 127.0.0.1
  port: 7781

sessions: []

adapters:
  web:
    module: '@rederjs/adapter-web'
    enabled: true
    config:
      bind: ${webBind}
      port: ${webPort}
`;

  writeFileSync(configPath, yaml, { mode: 0o600 });
  chmodSync(configPath, 0o600);

  if (!existsSync(envPath)) {
    const envHint = `# Environment variables for reder. Reference from reder.config.yaml via \${env:VAR}.\n`;
    writeFileSync(envPath, envHint, { mode: 0o600 });
    chmodSync(envPath, 0o600);
  }

  return { configPath, envPath, created: true };
}

export interface WebAdapterConfigSnapshot {
  bind: string;
  port: number;
}

export function readWebAdapterConfig(configPath: string): WebAdapterConfigSnapshot | undefined {
  if (!existsSync(configPath)) return undefined;
  const doc = parseDocument(readFileSync(configPath, 'utf8'));
  const bind = doc.getIn(['adapters', 'web', 'config', 'bind']);
  const port = doc.getIn(['adapters', 'web', 'config', 'port']);
  if (typeof bind !== 'string' || typeof port !== 'number') return undefined;
  return { bind, port };
}

export function updateWebAdapterConfig(opts: {
  configPath: string;
  bind: string;
  port: number;
}): void {
  const { configPath, bind, port } = opts;
  const doc = parseDocument(readFileSync(configPath, 'utf8'));

  if (!doc.hasIn(['adapters'])) {
    doc.set('adapters', doc.createNode({}));
  }
  if (!doc.hasIn(['adapters', 'web'])) {
    doc.setIn(
      ['adapters', 'web'],
      doc.createNode({
        module: '@rederjs/adapter-web',
        enabled: true,
        config: { bind, port },
      }),
    );
    atomicWrite(configPath, doc.toString());
    return;
  }

  doc.setIn(['adapters', 'web', 'module'], '@rederjs/adapter-web');
  doc.setIn(['adapters', 'web', 'enabled'], true);
  if (!doc.hasIn(['adapters', 'web', 'config'])) {
    doc.setIn(['adapters', 'web', 'config'], doc.createNode({ bind, port }));
  } else {
    doc.setIn(['adapters', 'web', 'config', 'bind'], bind);
    doc.setIn(['adapters', 'web', 'config', 'port'], port);
  }
  atomicWrite(configPath, doc.toString());
}

export interface PeekedSession {
  session_id: string;
  display_name: string;
  workspace_dir: string | undefined;
  auto_start: boolean;
}

export function peekSession(opts: {
  configPath: string;
  sessionId: string;
}): PeekedSession | undefined {
  if (!existsSync(opts.configPath)) return undefined;
  const doc = parseDocument(readFileSync(opts.configPath, 'utf8'));
  const seq = doc.get('sessions');
  if (!(seq instanceof YAMLSeq)) return undefined;
  for (const node of seq.items) {
    if (!(node instanceof YAMLMap)) continue;
    if (node.get('session_id') !== opts.sessionId) continue;
    const workspaceDir = node.get('workspace_dir');
    return {
      session_id: opts.sessionId,
      display_name: String(node.get('display_name') ?? opts.sessionId),
      workspace_dir: typeof workspaceDir === 'string' ? workspaceDir : undefined,
      auto_start: Boolean(node.get('auto_start') ?? false),
    };
  }
  return undefined;
}

export type UpsertOutcome =
  | { kind: 'created' }
  | { kind: 'updated_same' }
  | { kind: 'updated_workspace_dir'; previous: string | undefined }
  | { kind: 'updated_display_name'; previous: string }
  | { kind: 'updated_auto_start'; previous: boolean }
  | { kind: 'updated_multiple' };

export interface UpsertSessionOptions {
  configPath: string;
  sessionId: string;
  displayName: string;
  workspaceDir: string;
  autoStart: boolean;
}

export function upsertSession(opts: UpsertSessionOptions): UpsertOutcome {
  const { configPath, sessionId, displayName, workspaceDir, autoStart } = opts;
  const doc = parseDocument(readFileSync(configPath, 'utf8'));
  let seq = doc.get('sessions');
  if (!(seq instanceof YAMLSeq)) {
    seq = new YAMLSeq();
    doc.set('sessions', seq);
  }

  let entry: YAMLMap | undefined;
  for (const node of (seq as YAMLSeq).items) {
    if (node instanceof YAMLMap && node.get('session_id') === sessionId) {
      entry = node;
      break;
    }
  }

  if (!entry) {
    (seq as YAMLSeq).add({
      session_id: sessionId,
      display_name: displayName,
      workspace_dir: workspaceDir,
      auto_start: autoStart,
    });
    atomicWrite(configPath, doc.toString());
    return { kind: 'created' };
  }

  const prevDisplay = String(entry.get('display_name') ?? '');
  const prevWorkspaceRaw = entry.get('workspace_dir');
  const prevWorkspace = typeof prevWorkspaceRaw === 'string' ? prevWorkspaceRaw : undefined;
  const prevAutoStart = Boolean(entry.get('auto_start') ?? false);

  const displayChanged = prevDisplay !== displayName;
  const workspaceChanged = prevWorkspace !== workspaceDir;
  const autoStartChanged = prevAutoStart !== autoStart;

  if (!displayChanged && !workspaceChanged && !autoStartChanged) {
    return { kind: 'updated_same' };
  }

  entry.set('display_name', displayName);
  entry.set('workspace_dir', workspaceDir);
  entry.set('auto_start', autoStart);
  atomicWrite(configPath, doc.toString());

  const changes = [displayChanged, workspaceChanged, autoStartChanged].filter(Boolean).length;
  if (changes > 1) return { kind: 'updated_multiple' };
  if (workspaceChanged) return { kind: 'updated_workspace_dir', previous: prevWorkspace };
  if (displayChanged) return { kind: 'updated_display_name', previous: prevDisplay };
  return { kind: 'updated_auto_start', previous: prevAutoStart };
}

export function removeSession(opts: {
  configPath: string;
  sessionId: string;
}): { removed: boolean } {
  const doc = parseDocument(readFileSync(opts.configPath, 'utf8'));
  const seq = doc.get('sessions');
  if (!(seq instanceof YAMLSeq)) return { removed: false };
  const idx = seq.items.findIndex(
    (node) => node instanceof YAMLMap && node.get('session_id') === opts.sessionId,
  );
  if (idx < 0) return { removed: false };
  seq.delete(idx);
  atomicWrite(opts.configPath, doc.toString());
  return { removed: true };
}

function atomicWrite(filePath: string, contents: string): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, filePath);
}

// -----------------------------------------------------------------------------
// Telegram adapter config helpers
// -----------------------------------------------------------------------------

export type TelegramMode = 'pairing' | 'allowlist';

export interface TelegramBotEntry {
  session_id: string;
  token_env?: string;
  token?: string;
}

/**
 * Ensure `adapters.telegram` block exists with sensible defaults, returning
 * the telegram config map for caller-driven mutation.
 */
function ensureTelegramBlock(doc: Document): YAMLMap {
  if (!doc.has('adapters')) {
    doc.set('adapters', doc.createNode({}));
  }
  const adapters = doc.get('adapters');
  if (!(adapters instanceof YAMLMap)) {
    throw new Error('adapters: expected a mapping');
  }
  let telegram = adapters.get('telegram');
  if (!(telegram instanceof YAMLMap)) {
    telegram = doc.createNode({
      module: '@rederjs/adapter-telegram',
      enabled: true,
      config: { bots: [] },
    });
    adapters.set('telegram', telegram);
  }
  const tMap = telegram as YAMLMap;
  if (!tMap.has('module')) tMap.set('module', '@rederjs/adapter-telegram');
  if (!tMap.has('enabled')) tMap.set('enabled', true);
  if (!(tMap.get('config') instanceof YAMLMap)) {
    tMap.set('config', doc.createNode({ bots: [] }));
  }
  const cfg = tMap.get('config') as YAMLMap;
  if (!(cfg.get('bots') instanceof YAMLSeq)) {
    cfg.set('bots', new YAMLSeq());
  }
  return cfg;
}

export interface UpsertTelegramBotOptions {
  configPath: string;
  sessionId: string;
  tokenEnv?: string;
  token?: string;
}

export function upsertTelegramBot(opts: UpsertTelegramBotOptions): { created: boolean } {
  if (!opts.tokenEnv && !opts.token) {
    throw new Error('upsertTelegramBot: either tokenEnv or token must be set');
  }
  const doc = parseDocument(readFileSync(opts.configPath, 'utf8'));
  const cfg = ensureTelegramBlock(doc);
  const bots = cfg.get('bots') as YAMLSeq;

  let existing: YAMLMap | undefined;
  for (const node of bots.items) {
    if (node instanceof YAMLMap && node.get('session_id') === opts.sessionId) {
      existing = node;
      break;
    }
  }

  const entry: Record<string, string> = { session_id: opts.sessionId };
  if (opts.tokenEnv) entry['token_env'] = opts.tokenEnv;
  if (opts.token) entry['token'] = opts.token;

  if (existing) {
    // Clear both token fields so toggling between token/token_env is clean.
    if (existing.has('token')) existing.delete('token');
    if (existing.has('token_env')) existing.delete('token_env');
    for (const [k, v] of Object.entries(entry)) existing.set(k, v);
    atomicWrite(opts.configPath, doc.toString());
    return { created: false };
  }
  bots.add(entry);
  atomicWrite(opts.configPath, doc.toString());
  return { created: true };
}

export function removeTelegramBot(opts: {
  configPath: string;
  sessionId: string;
}): { removed: boolean } {
  const doc = parseDocument(readFileSync(opts.configPath, 'utf8'));
  const adapters = doc.get('adapters');
  if (!(adapters instanceof YAMLMap)) return { removed: false };
  const telegram = adapters.get('telegram');
  if (!(telegram instanceof YAMLMap)) return { removed: false };
  const cfg = telegram.get('config');
  if (!(cfg instanceof YAMLMap)) return { removed: false };
  const bots = cfg.get('bots');
  if (!(bots instanceof YAMLSeq)) return { removed: false };
  const idx = bots.items.findIndex(
    (n) => n instanceof YAMLMap && n.get('session_id') === opts.sessionId,
  );
  if (idx < 0) return { removed: false };
  bots.delete(idx);
  atomicWrite(opts.configPath, doc.toString());
  return { removed: true };
}

export function listTelegramBots(opts: { configPath: string }): TelegramBotEntry[] {
  if (!existsSync(opts.configPath)) return [];
  const doc = parseDocument(readFileSync(opts.configPath, 'utf8'));
  const bots = doc.getIn(['adapters', 'telegram', 'config', 'bots']);
  if (!(bots instanceof YAMLSeq)) return [];
  const out: TelegramBotEntry[] = [];
  for (const node of bots.items) {
    if (!(node instanceof YAMLMap)) continue;
    const sid = node.get('session_id');
    if (typeof sid !== 'string') continue;
    const entry: TelegramBotEntry = { session_id: sid };
    const te = node.get('token_env');
    const t = node.get('token');
    if (typeof te === 'string') entry.token_env = te;
    if (typeof t === 'string') entry.token = t;
    out.push(entry);
  }
  return out;
}

export function getTelegramMode(opts: { configPath: string }): TelegramMode {
  if (!existsSync(opts.configPath)) return 'pairing';
  const doc = parseDocument(readFileSync(opts.configPath, 'utf8'));
  const mode = doc.getIn(['adapters', 'telegram', 'config', 'mode']);
  return mode === 'allowlist' ? 'allowlist' : 'pairing';
}

export function setTelegramMode(opts: { configPath: string; mode: TelegramMode }): void {
  const doc = parseDocument(readFileSync(opts.configPath, 'utf8'));
  const cfg = ensureTelegramBlock(doc);
  cfg.set('mode', opts.mode);
  atomicWrite(opts.configPath, doc.toString());
}

function scalarValue(node: unknown): unknown {
  return isScalar(node) ? node.value : node;
}

export function listTelegramAllowlistUsers(opts: { configPath: string }): string[] {
  if (!existsSync(opts.configPath)) return [];
  const doc = parseDocument(readFileSync(opts.configPath, 'utf8'));
  const list = doc.getIn(['adapters', 'telegram', 'config', 'allowlist']);
  if (!(list instanceof YAMLSeq)) return [];
  const out: string[] = [];
  for (const node of list.items) {
    const raw = scalarValue(node);
    if (typeof raw === 'string') out.push(raw);
    else if (typeof raw === 'number') out.push(String(raw));
  }
  return out;
}

export function addTelegramAllowlistUser(opts: {
  configPath: string;
  userId: string;
}): { added: boolean } {
  if (!/^\d+$/.test(opts.userId)) {
    throw new Error(`userId must be numeric Telegram user_id (got '${opts.userId}')`);
  }
  const doc = parseDocument(readFileSync(opts.configPath, 'utf8'));
  const cfg = ensureTelegramBlock(doc);
  let list = cfg.get('allowlist');
  if (!(list instanceof YAMLSeq)) {
    list = new YAMLSeq();
    cfg.set('allowlist', list);
  }
  const seq = list as YAMLSeq;
  for (const node of seq.items) {
    const raw = scalarValue(node);
    const value = typeof raw === 'number' ? String(raw) : raw;
    if (value === opts.userId) return { added: false };
  }
  seq.add(opts.userId);
  atomicWrite(opts.configPath, doc.toString());
  return { added: true };
}

export function removeTelegramAllowlistUser(opts: {
  configPath: string;
  userId: string;
}): { removed: boolean } {
  const doc = parseDocument(readFileSync(opts.configPath, 'utf8'));
  const list = doc.getIn(['adapters', 'telegram', 'config', 'allowlist']);
  if (!(list instanceof YAMLSeq)) return { removed: false };
  const idx = list.items.findIndex((node) => {
    const raw = scalarValue(node);
    const value = typeof raw === 'number' ? String(raw) : raw;
    return value === opts.userId;
  });
  if (idx < 0) return { removed: false };
  list.delete(idx);
  atomicWrite(opts.configPath, doc.toString());
  return { removed: true };
}

