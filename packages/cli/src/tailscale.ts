import { spawnSync } from 'node:child_process';

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export function detectTailscaleIPv4(): string | undefined {
  let result;
  try {
    result = spawnSync('tailscale', ['ip', '-4'], {
      encoding: 'utf8',
      timeout: 2000,
    });
  } catch {
    return undefined;
  }
  if (result.status !== 0) return undefined;
  const first = (result.stdout ?? '').split('\n')[0]?.trim();
  if (!first || !IPV4_RE.test(first)) return undefined;
  return first;
}
