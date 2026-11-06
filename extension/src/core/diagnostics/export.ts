import { PROTOCOL_VERSION } from '@/core/contracts';
import { loadEngineState, loadSettings } from '@/core/storage/settings';
import { listEvents } from '@/core/logging/eventStore';
import { loadOnboarding } from '@/core/storage/settings';
import { listSelectorHealth, summarizeSelectorHealth } from '@/core/diagnostics/selectorHealth';
import { getQueueSummary } from '@/core/storage/tracker';
import {
  DIAGNOSTICS_NOTICE,
  REDACTION_VERSION,
  diagnosticEngine,
  diagnosticEvent,
  diagnosticHost,
  diagnosticOnboarding,
  diagnosticQueue,
  diagnosticSettings,
} from './privacy';
import { REDACTED, redactText } from '@/core/logging/redact';

export interface DiagnosticsBundle {
  privacyNotice: string;
  redactionVersion: number;
  generatedAt: string;
  version: string;
  protocol: number;
  host: string;
  settings: ReturnType<typeof diagnosticSettings>;
  engine: ReturnType<typeof diagnosticEngine>;
  onboarding: ReturnType<typeof diagnosticOnboarding>;
  events: ReturnType<typeof diagnosticEvent>[];
  selectorHealth: ReturnType<typeof summarizeSelectorHealth>;
  queueSummary: ReturnType<typeof diagnosticQueue>;
  counts: { events: number; selectorChecks: number };
}

export async function buildDiagnosticsBundle(version: string): Promise<DiagnosticsBundle> {
  const [settings, engine, onboarding, events, selectorHealth] = await Promise.all([
    loadSettings(),
    loadEngineState(),
    loadOnboarding(),
    listEvents(300),
    listSelectorHealth(),
  ]);
  return {
    privacyNotice: DIAGNOSTICS_NOTICE,
    redactionVersion: REDACTION_VERSION,
    generatedAt: new Date().toISOString(),
    version: /^\d+(?:\.\d+){1,3}$/.test(version) ? redactText(version) : REDACTED,
    protocol: PROTOCOL_VERSION,
    host: diagnosticHost(settings.host),
    settings: diagnosticSettings(settings),
    engine: diagnosticEngine(engine),
    onboarding: diagnosticOnboarding(onboarding),
    events: events.map(diagnosticEvent),
    selectorHealth: summarizeSelectorHealth(selectorHealth),
    queueSummary: diagnosticQueue(await getQueueSummary(settings)),
    counts: { events: events.length, selectorChecks: selectorHealth.length },
  };
}
