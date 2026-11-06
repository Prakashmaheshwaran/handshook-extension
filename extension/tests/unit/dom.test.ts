import { createElement, useState } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectorStrategy } from '@/core/contracts';
import {
  CancelledError,
  clickElement,
  closestFieldset,
  findByText,
  findAllByText,
  isVisible,
  openCombobox,
  pickOption,
  queryAllDeep,
  selectNative,
  setNativeValue,
  typeInto,
  waitFor,
  waitForDom,
  waitForGone,
  WaitTimeoutError,
} from '@/handshake/dom';
import { getAccessibleName } from '@/handshake/text';
import {
  findFirstStrategy,
  getConsecutiveFailures,
  getLastSuccessfulStrategy,
  getSelectorHealth,
  isSelectorUnhealthy,
  recordSelectorHealth,
  resetSelectorHealth,
  runStrategy,
} from '@/handshake/health';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function strategy(name: string, find: SelectorStrategy['find']): SelectorStrategy {
  return { name, kind: 'css', description: name, find };
}

beforeEach(() => {
  resetSelectorHealth();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('visibility', () => {
  it('treats connected, unstyled elements as visible', () => {
    document.body.innerHTML = '<div id="visible">Hello</div>';
    expect(isVisible(document.getElementById('visible'))).toBe(true);
  });

  it('hides display:none, hidden, aria-hidden, and detached elements', () => {
    document.body.innerHTML = `
      <div id="display" style="display: none">A</div>
      <div id="hidden" hidden>B</div>
      <div id="aria" aria-hidden="true">C</div>
      <div id="parent-none"><span id="child">D</span></div>
    `;
    const parent = document.getElementById('parent-none');
    if (parent) parent.style.display = 'none';
    const detached = document.createElement('div');
    detached.textContent = 'E';

    expect(isVisible(document.getElementById('display'))).toBe(false);
    expect(isVisible(document.getElementById('hidden'))).toBe(false);
    expect(isVisible(document.getElementById('aria'))).toBe(false);
    expect(isVisible(document.getElementById('child'))).toBe(false);
    expect(isVisible(detached)).toBe(false);
    expect(isVisible(null)).toBe(false);
  });
});

describe('text queries', () => {
  it('finds the interactive element rather than its inner span', () => {
    document.body.innerHTML = '<button id="apply"><span>Quick Apply</span></button>';
    const match = findByText(document, 'Quick Apply');
    expect(match?.id).toBe('apply');
  });

  it('ignores hidden matches and returns all visible matches', () => {
    document.body.innerHTML = `
      <button class="apply">Apply</button>
      <div style="display: none"><button class="apply">Apply</button></div>
      <a href="#x" class="apply">Apply now</a>
    `;
    expect(findAllByText(document, 'Apply').map((el) => el.tagName)).toEqual(['BUTTON', 'A']);
  });

  it('matches banners by normalized substring', () => {
    document.body.innerHTML = '<div role="status">You applied on Oct 1, 2026</div>';
    expect(findByText(document, /you applied on/)?.textContent).toContain('You applied');
  });

  it('returns null when nothing matches', () => {
    document.body.innerHTML = '<p>Nothing here</p>';
    expect(findByText(document, 'Apply')).toBeNull();
  });
});

describe('waits', () => {
  it('polls a condition without DOM mutations and cleans up on completion', async () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      const pending = waitForDom(document, () => ready, { timeoutMs: 1_000, intervalMs: 250 });
      ready = true;
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not accept a render delivered beyond the deadline when timers are throttled', async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForDom(document, () => document.querySelector('button'), {
        timeoutMs: 1_000,
      });
      const rejected = expect(pending).rejects.toBeInstanceOf(WaitTimeoutError);
      vi.setSystemTime(Date.now() + 1_001);
      document.body.innerHTML = '<button>Apply</button>';
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up the observer when its probe throws or starts cancelled', async () => {
    const disconnect = vi.spyOn(window.MutationObserver.prototype, 'disconnect');
    await expect(
      waitForDom(document, () => {
        throw new Error('Synthetic failure');
      }),
    ).rejects.toThrow('Synthetic failure');
    const controller = new AbortController();
    controller.abort();
    const probe = vi.fn(() => true);
    await expect(waitForDom(document, probe, { signal: controller.signal })).rejects.toBeInstanceOf(
      CancelledError,
    );
    expect(probe).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('resolves once a condition becomes true', async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 5);
    await expect(waitFor(() => ready, { timeoutMs: 500, intervalMs: 2 })).resolves.toBe(true);
  });

  it('rejects with CANCELLED when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitFor(() => true, { timeoutMs: 100, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('rejects with CANCELLED when aborted mid-wait', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await expect(
      waitFor(() => null, { timeoutMs: 1_000, intervalMs: 2, signal: controller.signal }),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  it('rejects with TIMEOUT after the deadline', async () => {
    await expect(waitFor(() => null, { timeoutMs: 10, intervalMs: 2 })).rejects.toBeInstanceOf(
      WaitTimeoutError,
    );
  });

  it('resolves waitForGone when the element is removed', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5);
    await expect(waitForGone(el, { timeoutMs: 500, intervalMs: 2 })).resolves.toBeUndefined();
  });

  it('resolves waitForGone when an element becomes hidden', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.display = 'none';
    }, 5);
    await expect(waitForGone(el, { timeoutMs: 500, intervalMs: 2 })).resolves.toBeUndefined();
  });

  it('keeps waiting for an element that is still connected', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    let gone = false;
    setTimeout(() => {
      el.remove();
      gone = true;
    }, 10);
    await waitForGone(() => (gone ? null : el), { timeoutMs: 500, intervalMs: 2 });
    expect(el.isConnected).toBe(false);
  });
});

describe('click, type, and select', () => {
  it('clicks an enabled button but not a disabled one', () => {
    document.body.innerHTML = `
      <button id="enabled">Apply</button>
      <button id="disabled" disabled>Apply</button>
    `;
    const onClick = vi.fn();
    document.getElementById('enabled')?.addEventListener('click', onClick);

    expect(clickElement(document.getElementById('enabled'))).toBe(true);
    expect(clickElement(document.getElementById('disabled'))).toBe(false);
    expect(clickElement(null)).toBe(false);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('writes a value and dispatches input and change events', () => {
    document.body.innerHTML = '<input id="name" value="before" />';
    const input = document.getElementById('name') as HTMLInputElement;
    const onInput = vi.fn();
    const onChange = vi.fn();
    input.addEventListener('input', onInput);
    input.addEventListener('change', onChange);

    setNativeValue(input, 'after');

    expect(input.value).toBe('after');
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('focuses and replaces the value unless the control is disabled', () => {
    document.body.innerHTML = `
      <input id="name" value="before" />
      <input id="off" value="keep" disabled />
    `;
    const input = document.getElementById('name') as HTMLInputElement;
    const disabled = document.getElementById('off') as HTMLInputElement;

    expect(typeInto(input, 'after')).toBe(true);
    expect(input.value).toBe('after');
    expect(document.activeElement).toBe(input);
    expect(typeInto(disabled, 'nope')).toBe(false);
    expect(disabled.value).toBe('keep');
  });

  it('selects a native option by value or label', () => {
    document.body.innerHTML = `
      <select id="docs">
        <option value="1">Resume</option>
        <option value="2">Cover letter</option>
      </select>
    `;
    const select = document.getElementById('docs') as HTMLSelectElement;
    const onChange = vi.fn();
    select.addEventListener('change', onChange);

    expect(selectNative(select, 'Cover letter')).toBe(true);
    expect(select.value).toBe('2');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(selectNative(select, 'missing')).toBe(false);
  });

  it('opens a combobox and picks an option by title', async () => {
    document.body.innerHTML = `
      <button id="trigger" aria-haspopup="listbox" aria-expanded="false">Choose document</button>
      <div id="list" role="listbox" hidden>
        <div role="option" data-value="a">Resume 2026</div>
        <div role="option" data-value="b">Cover letter</div>
      </div>
    `;
    const trigger = document.getElementById('trigger');
    const list = document.getElementById('list');
    trigger?.addEventListener('click', () => {
      trigger.setAttribute('aria-expanded', 'true');
      list?.removeAttribute('hidden');
    });
    const picked = vi.fn();
    document.getElementById('list')?.addEventListener('click', picked);

    const listbox = await openCombobox(trigger, { timeoutMs: 200, intervalMs: 5 });
    expect(listbox?.getAttribute('role')).toBe('listbox');
    const option = pickOption(listbox, 'Cover letter');
    expect(option?.getAttribute('data-value')).toBe('b');
    expect(picked).toHaveBeenCalledTimes(1);
  });

  it('returns null when a combobox never opens', async () => {
    document.body.innerHTML =
      '<button id="trigger">Choose document</button><div id="list" role="listbox" hidden></div>';
    await expect(
      openCombobox(document.getElementById('trigger'), { timeoutMs: 20, intervalMs: 5 }),
    ).resolves.toBeNull();
  });
});

describe('structural helpers', () => {
  it('finds the nearest fieldset or ARIA group', () => {
    document.body.innerHTML = '<fieldset><input id="inside" /></fieldset>';
    expect(closestFieldset(document.getElementById('inside'))?.tagName).toBe('FIELDSET');
    expect(closestFieldset(null)).toBeNull();
  });

  it('queries inside open shadow roots', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host');
    const shadow = host?.attachShadow({ mode: 'open' });
    const span = document.createElement('span');
    span.setAttribute('data-doc', '1');
    shadow?.appendChild(span);

    const found = queryAllDeep(document, '[data-doc="1"]');
    expect(found).toHaveLength(1);
  });
});

describe('accessible names', () => {
  it('prefers aria-label, aria-labelledby, label[for], wrapping label, then text', () => {
    document.body.innerHTML = `
      <span id="external">Account email</span>
      <input id="a" aria-label="Full name" />
      <input id="b" aria-labelledby="external" />
      <label for="c">Account email</label><input id="c" />
      <label>Wrapped field <input id="d" /></label>
      <button id="e">Visible label</button>
      <select id="f"><option>First option</option></select>
    `;

    expect(getAccessibleName(document.getElementById('a'))).toBe('Full name');
    expect(getAccessibleName(document.getElementById('b'))).toBe('Account email');
    expect(getAccessibleName(document.getElementById('c'))).toBe('Account email');
    expect(getAccessibleName(document.getElementById('d'))).toBe('Wrapped field');
    expect(getAccessibleName(document.getElementById('e'))).toBe('Visible label');
    expect(getAccessibleName(document.getElementById('f'))).toBe('');
    expect(getAccessibleName(null)).toBe('');
  });
});

describe('React-controlled inputs', () => {
  it('updates React state when setNativeValue is used', async () => {
    let observed = 'before';

    function Controlled({
      onValue,
    }: {
      onValue: (value: string) => void;
    }): ReturnType<typeof createElement> {
      const [value, setValue] = useState('before');
      return createElement('input', {
        'aria-label': 'Name',
        value,
        onChange: (event: { target: { value: string } }) => {
          setValue(event.target.value);
          onValue(event.target.value);
        },
      });
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(Controlled, {
          onValue: (value: string) => {
            observed = value;
          },
        }),
      );
    });
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    if (!input) return;

    await act(async () => {
      setNativeValue(input, 'after');
    });

    expect(input.value).toBe('after');
    expect(observed).toBe('after');
    await act(async () => {
      root.unmount();
    });
  });
});

describe('selector health', () => {
  const first: SelectorStrategy = strategy('css:first', (root) => root.querySelector('#missing'));
  const second: SelectorStrategy = strategy('css:second', (root) => root.querySelector('#found'));

  it('records the winning strategy and resets failures', () => {
    document.body.innerHTML = '<div id="found"></div>';
    const match = runStrategy('apply.button', [first, second], document, 'job');
    expect(match?.strategy).toBe('css:second');
    expect(getConsecutiveFailures('apply.button')).toBe(0);
    expect(getLastSuccessfulStrategy('apply.button')).toBe('css:second');
    expect(getSelectorHealth().at(-1)).toMatchObject({
      selector: 'apply.button',
      strategy: 'css:second',
      ok: true,
      page: 'job',
    });
  });

  it('counts consecutive failures and flags the group unhealthy at three', () => {
    document.body.innerHTML = '<div></div>';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(runStrategy('apply.button', [first, second], document, 'job')).toBeNull();
    }
    expect(getConsecutiveFailures('apply.button')).toBe(3);
    expect(isSelectorUnhealthy('apply.button')).toBe(true);
    expect(getSelectorHealth().at(-1)).toMatchObject({ ok: false, strategy: 'none' });

    document.body.innerHTML = '<div id="found"></div>';
    runStrategy('apply.button', [first, second], document, 'job');
    expect(getConsecutiveFailures('apply.button')).toBe(0);
    expect(isSelectorUnhealthy('apply.button')).toBe(false);
  });

  it('resets history and counters', () => {
    recordSelectorHealth({
      at: 1,
      page: 'search',
      selector: 'discovery.nextPage',
      strategy: 'text:next',
      ok: false,
    });
    expect(getSelectorHealth()).toHaveLength(1);
    resetSelectorHealth();
    expect(getSelectorHealth()).toHaveLength(0);
    expect(getConsecutiveFailures('discovery.nextPage')).toBe(0);
  });

  it('findFirstStrategy does not record health', () => {
    document.body.innerHTML = '<div id="found"></div>';
    expect(findFirstStrategy([first, second], document)?.id).toBe('found');
    expect(getSelectorHealth()).toHaveLength(0);
  });
});
