import { expect, test } from '../helpers/extension';
import { seedExtension, sendUi } from '../helpers/seed';
import type { Settings } from '../../../src/core/contracts';

test('speed slider shows the derived rate, hides raw timing and saves presets at narrow panel width', async ({
  sidePanel,
  pageErrors,
}) => {
  await seedExtension(sidePanel, { settings: { pacing: { speed: 4, useAdvanced: false } } });
  await sidePanel.setViewportSize({ width: 320, height: 800 });
  await sidePanel.reload();
  await sidePanel
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  const speed = sidePanel.getByRole('slider', { name: 'Speed', exact: true });
  await expect(speed).toHaveValue('4');
  await expect(speed).toHaveAttribute('aria-valuetext', 'Faster');
  await expect(
    sidePanel.getByText('About 32–40 applications per hour, including apply time and breaks.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(sidePanel.getByLabel('Shortest delay (seconds)', { exact: true })).toHaveCount(0);
  await expect(sidePanel.getByLabel('Delay jitter (%)', { exact: true })).toHaveCount(0);
  await speed.press('ArrowRight');
  await expect(speed).toHaveValue('5');
  await expect(speed).toHaveAttribute('aria-valuetext', 'Fastest');
  await sidePanel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sidePanel.getByText('Settings saved.', { exact: true })).toBeVisible();
  const settings = await sendUi<Settings>(sidePanel, {
    type: 'ui.settings.get',
    requestId: 'pacing-preset-read',
  });
  expect(settings.pacing).toMatchObject({ speed: 5, useAdvanced: false, dailyCap: 25 });
  await sidePanel.reload();
  await sidePanel
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await expect(sidePanel.getByRole('slider', { name: 'Speed', exact: true })).toHaveValue('5');
  expect(pageErrors).toEqual([]);
});

test('saved custom timing shows its own rate and moving the slider returns to a preset', async ({
  sidePanel,
}) => {
  await seedExtension(sidePanel, {
    settings: {
      pacing: {
        speed: 4,
        useAdvanced: true,
        minDelayMs: 25_000,
        maxDelayMs: 25_000,
        jitterPercent: 0,
        sessionBatchSize: 1,
        sessionBreakMinMs: 0,
        sessionBreakMaxMs: 0,
      },
    },
  });
  await sidePanel.reload();
  await sidePanel
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  const speed = sidePanel.getByRole('slider', { name: 'Speed', exact: true });
  await expect(speed).toHaveAttribute('aria-valuetext', 'Custom');
  await expect(
    sidePanel.getByText('About 90 applications per hour, including apply time and breaks.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(sidePanel.getByText('Advanced pacing', { exact: true })).toHaveCount(0);
  await speed.press('ArrowRight');
  await expect(speed).toHaveValue('5');
  await expect(speed).toHaveAttribute('aria-valuetext', 'Fastest');
  await sidePanel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sidePanel.getByText('Settings saved.', { exact: true })).toBeVisible();
  expect(
    (
      await sendUi<Settings>(sidePanel, {
        type: 'ui.settings.get',
        requestId: 'pacing-custom-read',
      })
    ).pacing,
  ).toMatchObject({
    speed: 5,
    useAdvanced: false,
  });
});
