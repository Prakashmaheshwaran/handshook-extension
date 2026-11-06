import type { ComponentType, SVGProps } from 'react';

export interface IconProps {
  size?: number;
  className?: string;
  /** Icons are decorative by default; pass a title for standalone meaning. */
  title?: string;
}

function base(props: IconProps): SVGProps<SVGSVGElement> {
  const { size = 16, className, title } = props;
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className,
    role: title ? 'img' : undefined,
    'aria-hidden': title ? undefined : true,
    focusable: false,
  } as SVGProps<SVGSVGElement>;
}

function Label({ title }: { title?: string }) {
  if (!title) return null;
  return <title>{title}</title>;
}

export function IconDashboard(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function IconQueue(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" strokeWidth={2.6} />
    </svg>
  );
}

export function IconNeeds(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="M12 3.5 21 20H3L12 3.5Z" />
      <path d="M12 9.5v4.5M12 17h.01" />
    </svg>
  );
}

export function IconActivity(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="M3 12h3.5l2.5-7 4 14 2.5-7H21" />
    </svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2.2" />
      <circle cx="8" cy="17" r="2.2" />
    </svg>
  );
}

export function IconDiagnostics(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="M9 3h6v4l3 3v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-9l3-3V3Z" />
      <path d="M9 13h2l1.5-2.5L14 15l1-2h1" />
    </svg>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="M7 4.5 19 12 7 19.5v-15Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconPause(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
      <rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconStop(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4.5V11h-6" />
    </svg>
  );
}

export function IconExternal(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="M14 4h6v6M20 4l-8.5 8.5" />
      <path d="M18 14.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4.5" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="m6 9.5 6 6 6-6" />
    </svg>
  );
}

export function IconArrowLeft(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5" />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L18.5 7" />
      <path d="M10.5 11v6M13.5 11v6" />
    </svg>
  );
}

export function IconDownload(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4.5 18.5h15" />
    </svg>
  );
}

export function IconShield(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="M12 3.5 20 6v6c0 4.2-3.3 7.4-8 8.5-4.7-1.1-8-4.3-8-8.5V6l8-2.5Z" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  );
}

export function IconDocument(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-5.5-5.5Z" />
      <path d="M13.5 3.5V9H19M8.5 13h7M8.5 17h5" />
    </svg>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8h.01" />
    </svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function IconLock(props: IconProps) {
  return (
    <svg {...base(props)}>
      <Label title={props.title} />
      <rect x="4.5" y="10" width="15" height="10" rx="2" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
    </svg>
  );
}

export const ICONS: Record<
  'dashboard' | 'queue' | 'needs' | 'activity' | 'settings' | 'diagnostics',
  ComponentType<IconProps>
> = {
  dashboard: IconDashboard,
  queue: IconQueue,
  needs: IconNeeds,
  activity: IconActivity,
  settings: IconSettings,
  diagnostics: IconDiagnostics,
};

export type NavIconName = keyof typeof ICONS;
