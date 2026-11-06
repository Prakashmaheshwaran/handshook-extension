import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStep, type SessionStepProps } from '@/ui/screens/Onboarding/SessionStep';

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

function render(props: Partial<SessionStepProps> = {}): void {
  act(() => {
    root.render(
      <SessionStep
        status="unchecked"
        host="app.joinhandshake.com"
        checking={false}
        onCheck={vi.fn()}
        {...props}
      />,
    );
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(
    (entry) => entry.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button ${label}`);
  return match;
}

describe('session step reports the real outcome', () => {
  it('shows the pre-check state without claiming a result', () => {
    render();
    expect(container.textContent).toContain('Not checked yet');
    expect(container.textContent).not.toContain('Checked in the Handshook runner tab');
    expect(container.textContent).not.toContain("Couldn't verify");
  });

  it('shows signed in with where and when the check ran', () => {
    render({ status: 'logged_in', checkedAt: Date.now() });
    expect(container.textContent).toContain('Signed in on this browser');
    expect(container.textContent).toContain('Checked in the Handshook runner tab');
    expect(container.textContent).toContain('just now');
  });

  it('shows a signed-out result with the sign-in guidance', () => {
    render({ status: 'logged_out', checkedAt: Date.now() });
    expect(container.textContent).toContain('Not signed in');
    expect(container.textContent).toContain('Sign in on Handshake in a normal tab');
    expect(container.textContent).toContain('Checked in the Handshook runner tab');
  });

  it('turns a failed check into "couldn\'t verify", not "not checked yet"', () => {
    render({ status: 'not_verified', checkedAt: Date.now() });
    expect(container.textContent).toContain("Couldn't verify");
    expect(container.textContent).toContain('did not finish loading');
    expect(container.textContent).not.toContain('Not checked yet');
    expect(button('Check again')).toBeTruthy();
  });

  it('keeps the first run labelled Check session and offers Check again after a failure', () => {
    render();
    expect(button('Check session')).toBeTruthy();
    render({ status: 'not_verified', checkedAt: Date.now() });
    expect(button('Check again')).toBeTruthy();
  });

  it('calls onCheck from either affordance', () => {
    const onCheck = vi.fn();
    render({ onCheck });
    act(() => button('Check session').click());
    expect(onCheck).toHaveBeenCalledTimes(1);

    render({ status: 'not_verified', checkedAt: Date.now(), onCheck });
    act(() => button('Check again').click());
    expect(onCheck).toHaveBeenCalledTimes(2);
  });
});
