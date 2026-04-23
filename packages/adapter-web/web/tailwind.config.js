/** @type {import('tailwindcss').Config} */
import containerQueries from '@tailwindcss/container-queries';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default {
  content: [join(here, 'index.html'), join(here, 'src/**/*.{ts,tsx}')],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        serif: ['"Instrument Serif"', 'serif'],
      },
      colors: {
        bg: 'var(--bg)',
        'bg-1': 'var(--bg-1)',
        'bg-2': 'var(--bg-2)',
        'bg-3': 'var(--bg-3)',
        line: 'var(--line)',
        'line-2': 'var(--line-2)',
        fg: 'var(--fg)',
        'fg-2': 'var(--fg-2)',
        'fg-3': 'var(--fg-3)',
        'fg-4': 'var(--fg-4)',
        accent: 'var(--accent)',
        'accent-soft': 'var(--accent-soft)',
        'accent-dim': 'var(--accent-dim)',
        'bubble-me': 'var(--bubble-me)',
        'bubble-them': 'var(--bubble-them)',
        'st-waiting': 'var(--st-waiting)',
        'st-busy': 'var(--st-busy)',
        'st-idle': 'var(--st-idle)',
        'st-offline': 'var(--st-offline)',
      },
      keyframes: {
        'pulse-ring': {
          '0%': { transform: 'scale(1)', opacity: '1' },
          '100%': { transform: 'scale(1.35)', opacity: '0' },
        },
        scanbar: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(350%)' },
        },
        wave: {
          '0%, 100%': { transform: 'scaleY(.4)' },
          '50%': { transform: 'scaleY(1)' },
        },
        'caret-blink': {
          '50%': { opacity: '0' },
        },
        'dot-blink': {
          '50%': { opacity: '0.25' },
        },
        'live-wave': {
          '0%, 100%': { height: '20%' },
          '50%': { height: '85%' },
        },
        'scrim-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'tweak-in': {
          '0%': { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'pulse-ring': 'pulse-ring 1.6s ease-out infinite',
        scanbar: 'scanbar 1.6s linear infinite',
        wave: 'wave 1s ease-in-out infinite',
        'caret-blink': 'caret-blink 1.1s steps(2) infinite',
        'dot-blink': 'dot-blink 1.2s infinite',
        'dot-blink-fast': 'dot-blink .6s infinite',
        'dot-blink-slow': 'dot-blink 1.6s infinite',
        'live-wave': 'live-wave 0.85s ease-in-out infinite',
        'scrim-in': 'scrim-in .18s ease',
        'tweak-in': 'tweak-in .22s cubic-bezier(.2,.9,.3,1.1)',
      },
      boxShadow: {
        glow: '0 0 24px var(--glow)',
        'card-selected': '0 0 0 1px var(--accent), 0 0 32px -8px var(--glow)',
        tweaks:
          '0 0 0 1px var(--accent), 0 0 40px -8px var(--glow), 0 30px 60px -10px rgba(0,0,0,0.6), inset 0 1px 0 color-mix(in oklab, var(--accent) 30%, transparent)',
        'panel-overlay': '-30px 0 60px -10px #000',
      },
      transitionTimingFunction: {
        'spring-out': 'cubic-bezier(.2,.8,.2,1)',
      },
    },
  },
  plugins: [containerQueries],
};
