import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.REDER_DAEMON_URL ?? 'http://127.0.0.1:7781',
      '/health': process.env.REDER_DAEMON_URL ?? 'http://127.0.0.1:7781',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
