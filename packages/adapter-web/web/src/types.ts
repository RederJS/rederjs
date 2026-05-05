export type Status = 'working' | 'awaiting-user' | 'idle' | 'unknown' | 'offline';

export type Theme = 'dark' | 'light';

export type Accent = 'blue' | 'mint' | 'amber' | 'coral' | 'violet';

export type CardVariant = 'tactical' | 'panel' | 'compact';
export type StatusVariant = 'ringed' | 'corner' | 'pill';
export type BubbleVariant = 'classic' | 'terminal' | 'minimal';
export type ComposerVariant = 'rail' | 'segmented' | 'minimal';
export type PanelVariant = 'push' | 'overlay' | 'takeover';
export type SortKey = 'priority' | 'recent' | 'name';
export type VoiceScope = 'always' | 'idle-or-awaiting';

export interface Tweaks {
  theme: Theme;
  accent: Accent;
  cols: number;
  card: CardVariant;
  status: StatusVariant;
  bubble: BubbleVariant;
  composer: ComposerVariant;
  panel: PanelVariant;
  voiceScope: VoiceScope;
  voicePauseMs: number;
}

export const ACCENT_HEX: Record<Accent, string> = {
  blue: '#4f8cff',
  mint: '#7cd38c',
  amber: '#e0b341',
  coral: '#ff6b9d',
  violet: '#b281ff',
};

export const DEFAULT_TWEAKS: Tweaks = {
  theme: 'dark',
  accent: 'blue',
  cols: 3,
  card: 'tactical',
  status: 'ringed',
  bubble: 'classic',
  composer: 'rail',
  panel: 'push',
  voiceScope: 'always',
  voicePauseMs: 1500,
};

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolName: string;
  description: string;
  inputPreview: string;
  expiresAt: string;
}

export interface QuickReply {
  label: string;
  value: string;
  kind?: 'primary' | 'danger';
}
