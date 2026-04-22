import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import { defaultRuntimeDir, defaultDataDir } from '../paths.js';

export interface ScaffoldOptions {
  configPath: string;
  envPath: string;
  webBind: string;
  webPort: number;
  botToken?: string | undefined;
}

export interface ScaffoldResult {
  configPath: string;
  envPath: string;
  created: boolean;
}

export function scaffoldConfig(opts: ScaffoldOptions): ScaffoldResult {
  const { configPath, envPath, webBind, webPort, botToken } = opts;

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

  const envLine = botToken
    ? `# Telegram bot tokens go here, one per session, e.g.\n# TELEGRAM_BOT_MYSESSION=${botToken}\n`
    : `# Telegram bot tokens go here, one per session, e.g.\n# TELEGRAM_BOT_MYSESSION=123:abc\n`;
  if (!existsSync(envPath)) {
    writeFileSync(envPath, envLine, { mode: 0o600 });
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
