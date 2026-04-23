import type { ReactNode, SVGProps } from 'react';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'fill' | 'stroke'> {
  size?: number;
  sw?: number;
  fill?: string;
  stroke?: string;
  vb?: number;
  d?: string;
  children?: ReactNode;
}

function I({
  d,
  size = 16,
  fill = 'none',
  stroke = 'currentColor',
  sw = 1.6,
  vb = 24,
  children,
  ...rest
}: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${vb} ${vb}`}
      fill={fill}
      stroke={stroke}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {d ? <path d={d} /> : children}
    </svg>
  );
}

type IconComponent = (p: Omit<IconProps, 'd' | 'children'>) => JSX.Element;

export const Icons: Record<string, IconComponent> = {
  grid: (p) => (
    <I {...p}>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </I>
  ),
  list: (p) => <I {...p} d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  terminal: (p) => <I {...p} d="M4 17l6-6-6-6M12 19h8" />,
  settings: (p) => (
    <I {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3h0a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5h0a1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8v0a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </I>
  ),
  search: (p) => (
    <I {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </I>
  ),
  plus: (p) => <I {...p} d="M12 5v14M5 12h14" />,
  close: (p) => <I {...p} d="M18 6L6 18M6 6l12 12" />,
  chevR: (p) => <I {...p} d="M9 18l6-6-6-6" />,
  chevL: (p) => <I {...p} d="M15 18l-6-6 6-6" />,
  chevD: (p) => <I {...p} d="M6 9l6 6 6-6" />,
  send: (p) => <I {...p} d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />,
  paperclip: (p) => (
    <I
      {...p}
      d="M21.4 11L12.2 20.2a5.6 5.6 0 01-7.9-7.9L13.6 3a3.7 3.7 0 015.3 5.2l-9.2 9.3a1.9 1.9 0 01-2.7-2.7l8.5-8.5"
    />
  ),
  mic: (p) => (
    <I {...p}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M19 10a7 7 0 01-14 0M12 19v3" />
    </I>
  ),
  bell: (p) => <I {...p} d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" />,
  more: (p) => (
    <I {...p}>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </I>
  ),
  fullscreen: (p) => <I {...p} d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />,
  sun: (p) => (
    <I {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </I>
  ),
  moon: (p) => <I {...p} d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />,
  filter: (p) => <I {...p} d="M3 6h18M7 12h10M10 18h4" />,
  pause: (p) => (
    <I {...p}>
      <rect x="6" y="5" width="4" height="14" />
      <rect x="14" y="5" width="4" height="14" />
    </I>
  ),
  play: (p) => <I {...p} d="M6 4l14 8-14 8V4z" />,
  pin: (p) => <I {...p} d="M12 17v5M9 3h6l-1 7 3 3H7l3-3-1-7z" />,
  eye: (p) => (
    <I {...p}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </I>
  ),
  stop: (p) => (
    <I {...p}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </I>
  ),
  cpu: (p) => (
    <I {...p}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
    </I>
  ),
  folder: (p) => (
    <I {...p} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
  ),
};

export type IconName = keyof typeof Icons;
