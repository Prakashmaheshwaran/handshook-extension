import { expect, test } from '../helpers/extension';
import { seedExtension } from '../helpers/seed';
import type { Settings } from '../../../src/core/contracts';

for (const width of [320, 400, 500]) {
  test(`Beta features migrate off and persist the external-link opt-in at ${width}px`, async ({
    sidePanel,
    pageErrors,
  }) => {
    await sidePanel.setViewportSize({ width, height: 900 });
    await seedExtension(sidePanel, { settings: { ai: { provider: 'auto' } } });
    // Simulate an installed release whose settings predate the external beta field.
    await sidePanel.evaluate(async () => {
      const key = 'handshook.settings.v1';
      const stored = (await chrome.storage.local.get(key))[key] as Settings;
      const legacySearch: Record<string, unknown> = stored.search;
      delete legacySearch.collectExternalJobs;
      await chrome.storage.local.set({ [key]: stored });
    });
    await sidePanel.reload();
    await sidePanel.getByRole('button', { name: 'Settings', exact: true }).click();
    const external = sidePanel.getByRole('switch', {
      name: 'Collect external job links (beta)',
      exact: true,
    });
    await expect(external).toHaveAttribute('aria-checked', 'false');
    await expect(sidePanel.locator('#beta')).toContainText('off by default');
    // The removed model download control must not reappear in the Beta section.
    await expect(sidePanel.locator('#beta').getByRole('switch')).toHaveCount(1);
    await external.click();
    await sidePanel.getByRole('button', { name: 'Save', exact: true }).click();
    await sidePanel.reload();
    await sidePanel.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(external).toHaveAttribute('aria-checked', 'true');
    await external.click();
    await sidePanel.getByRole('button', { name: 'Save', exact: true }).click();
    const settings = await sidePanel.evaluate(
      async () =>
        (await chrome.storage.local.get('handshook.settings.v1'))[
          'handshook.settings.v1'
        ] as Settings,
    );
    expect(settings.ai.provider).toBe('auto');
    expect(settings.search.collectExternalJobs).toBe(false);
    expect(
      await sidePanel.locator('main').evaluate((node) => node.scrollWidth - node.clientWidth),
    ).toBeLessThanOrEqual(1);
    expect(pageErrors).toEqual([]);
  });
}
