import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function discoverDaemonUrl(): string {
  if (process.env.REDER_DAEMON_URL) return process.env.REDER_DAEMON_URL;
  const candidates = [
    process.env.REDER_CONFIG,
    join(homedir(), '.config/reder/reder.config.yaml'),
    join(homedir(), '.config/reder/reder.config.yml'),
  ].filter(Boolean) as string[];
  for (const path of candidates) {
    try {
      const text = readFileSync(path, 'utf8');
      const m = text.match(/adapters:[\s\S]*?web:[\s\S]*?config:\s*\n([\s\S]*?)(?=\n\S|\n\s*$)/);
      const block = m?.[1];
      if (!block) continue;
      const bindMatch = block.match(/^\s*bind:\s*['"]?([^'"\s#]+)/m);
      const portMatch = block.match(/^\s*port:\s*(\d+)/m);
      const rawBind = bindMatch?.[1];
      const port = portMatch?.[1];
      if (rawBind && port) {
        const bind = rawBind === '0.0.0.0' || rawBind === '::' ? '127.0.0.1' : rawBind;
        return `http://${bind}:${port}`;
      }
    } catch {
      // file not present; try next
    }
  }
  return 'http://127.0.0.1:7781';
}

const DAEMON_URL = discoverDaemonUrl();

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': DAEMON_URL,
      '/health': DAEMON_URL,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
