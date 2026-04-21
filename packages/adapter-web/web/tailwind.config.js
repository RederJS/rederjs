/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        canvas: '#0b0d12',
        panel: '#13161d',
        panel2: '#1a1e27',
        border: '#272d3a',
        muted: '#6b7386',
        accent: '#e87f3e',
        accent2: '#c56830',
        ok: '#4ade80',
        warn: '#fbbf24',
        err: '#f87171',
      },
    },
  },
  plugins: [],
};
