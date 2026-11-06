import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunMode } from '@/core/contracts';
import { makeSettings } from '@/test/factories';
import { ModeStep } from '@/ui/screens/Onboarding/ModeStep';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(
  mode: RunMode,
  reviewBeforeSubmit: boolean,
  onReviewBeforeSubmit = vi.fn(),
  onAllowOneClickApply = vi.fn(),
  onMode = vi.fn(),
): void {
  act(() => {
    root.render(
      <ModeStep
        mode={mode}
        onMode={onMode}
        documentsChosen={1}
        answersFilled={1}
        searchReady
        sensitiveAutoCount={0}
        reviewBeforeSubmit={reviewBeforeSubmit}
        onReviewBeforeSubmit={onReviewBeforeSubmit}
        allowOneClickApply={false}
        onAllowOneClickApply={onAllowOneClickApply}
      />,
    );
  });
}

function radio(value: RunMode): HTMLInputElement {
  const match = Array.from(
    container.querySelectorAll<HTMLInputElement>('input[name="onboarding-mode"]'),
  ).find((entry) => entry.value === value);
  if (!match) throw new Error(`Missing ${value} radio`);
  return match;
}

describe('onboarding presents full automation as the default', () => {
  it('preselects Autopilot, labels it recommended, and does not call Review the default', () => {
    const settings = makeSettings();
    render(settings.mode, settings.safety.reviewBeforeSubmit);
    expect(radio('autopilot').checked).toBe(true);
    expect(radio('review').checked).toBe(false);
    expect(radio('dry_run').checked).toBe(false);
    expect(container.textContent).toContain('Handshook applies for you (recommended)');
    expect(container.textContent).not.toMatch(/Review is the default/i);
    expect(container.textContent).not.toMatch(/review before submit \(recommended\)/i);
  });

  it('presents Review and Dry run as opt-outs', () => {
    render('autopilot', false);
    expect(container.textContent).toContain('Review each application before it is submitted');
    expect(container.textContent).toContain('Turns off automatic submitting');
    expect(container.textContent).toContain('Dry run: nothing will be submitted');
  });

  it('states the only two things that stop a job', () => {
    render('autopilot', false);
    expect(container.textContent).toContain('a required question with no saved answer');
    expect(container.textContent).toContain('a required document type with no entered ID');
    expect(container.textContent).toMatch(/future jobs continue automatically/i);
  });

  it('keeps review-before-submit as an opt-out that is off by default', () => {
    render('autopilot', false);
    expect(container.textContent).toContain('Review each application before it is submitted');
    expect(container.textContent).toMatch(/off by default \(fully automatic\)/i);
    expect(container.textContent).not.toMatch(/submits without showing you the answers first/i);
  });

  it('explains review when the user turns the opt-out on', () => {
    render('autopilot', true);
    expect(container.textContent).toMatch(/fill each application and wait for you/i);
    expect(container.textContent).toMatch(/Settings → Run mode and safety/i);
  });

  it('toggles the review opt-out from the switch', () => {
    const onReviewBeforeSubmit = vi.fn();
    render('autopilot', false, onReviewBeforeSubmit);
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle).not.toBeNull();
    act(() => toggle?.click());
    expect(onReviewBeforeSubmit).toHaveBeenCalledWith(true);
  });

  it('keeps Handshake one-click consent off until the user allows it', () => {
    const change = vi.fn();
    render('autopilot', false, vi.fn(), change);
    expect(container.textContent).toContain('Let Autopilot use Handshake one-click Apply');
    expect(container.textContent).toContain("Handshook can't change them");
    expect(container.textContent).toContain(
      'Jobs that need other documents or answers still wait for you',
    );
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(false);
    act(() => checkbox?.click());
    expect(change).toHaveBeenCalledWith(true);
  });

  it('never claims autopilot is quick-apply only', () => {
    render('autopilot', false);
    expect(container.textContent).not.toMatch(/quick-apply jobs only/i);
  });
});
