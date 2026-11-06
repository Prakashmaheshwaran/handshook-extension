import type { NavIconName } from '@/ui/components/icons';
import type { OnboardingState } from '@/core/contracts';

export const SETUP_ROUTES = {
  onboarding: 'welcome',
  'setup-session': 'session',
  'setup-documents': 'documents',
  'setup-search': 'search',
  'setup-mode': 'mode',
} as const satisfies Record<string, OnboardingState['step']>;

export function setupStep(view: View): OnboardingState['step'] | undefined {
  return view in SETUP_ROUTES ? SETUP_ROUTES[view as keyof typeof SETUP_ROUTES] : undefined;
}

/** Every screen the side panel can show. No URL router: the panel is a single view. */
export const VIEWS = [
  'onboarding',
  'setup-session',
  'setup-documents',
  'setup-search',
  'setup-mode',
  'dashboard',
  'queue',
  'needs',
  'activity',
  'settings',
  'diagnostics',
] as const;

export type View = (typeof VIEWS)[number];

/** Views reachable from the primary navigation. */
export type NavView = 'dashboard' | 'queue' | 'needs' | 'activity' | 'settings';

export interface NavItem {
  view: NavView;
  label: string;
  /** Longer label for the screen heading. */
  heading: string;
  icon: NavIconName;
  /** Shown next to the label when the engine wants attention. */
  needsAttention?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { view: 'dashboard', label: 'Home', heading: 'Dashboard', icon: 'dashboard' },
  { view: 'queue', label: 'Queue', heading: 'Queue', icon: 'queue' },
  { view: 'needs', label: 'Needs', heading: 'Needs you', icon: 'needs', needsAttention: true },
  { view: 'activity', label: 'Activity', heading: 'Activity', icon: 'activity' },
  { view: 'settings', label: 'Settings', heading: 'Settings', icon: 'settings' },
];

export const VIEW_META: Partial<Record<View, { title: string; subtitle: string }>> & {
  dashboard: { title: string; subtitle: string };
} = {
  onboarding: {
    title: 'Set up Handshook',
    subtitle: 'Six short steps. Nothing is submitted without your say-so.',
  },
  dashboard: {
    title: 'Dashboard',
    subtitle: 'What Handshook is doing, and what it needs from you.',
  },
  queue: {
    title: 'Queue',
    subtitle: 'Jobs that matched your saved search, ranked by fit.',
  },
  needs: {
    title: 'Needs you',
    subtitle: 'Review pending applications, questions, and documents.',
  },
  activity: {
    title: 'Activity',
    subtitle: 'Everything the run did, newest first.',
  },
  settings: {
    title: 'Settings',
    subtitle: 'Search, pacing, documents, answers, AI, and safety.',
  },
  diagnostics: {
    title: 'Diagnostics',
    subtitle: 'Selector health, recent errors, and an export bundle.',
  },
};

/** Settings sections deep-linked from other screens. */
export type SettingsSection =
  'search' | 'pacing' | 'documents' | 'answers' | 'ai' | 'beta' | 'safety' | 'advanced';

export const SETTINGS_SECTIONS: readonly { id: SettingsSection; label: string }[] = [
  { id: 'search', label: 'Search' },
  { id: 'pacing', label: 'Pacing' },
  { id: 'documents', label: 'Documents' },
  { id: 'answers', label: 'Answers' },
  { id: 'ai', label: 'AI' },
  { id: 'beta', label: 'Beta features' },
  { id: 'safety', label: 'Safety' },
  { id: 'advanced', label: 'Advanced' },
];
