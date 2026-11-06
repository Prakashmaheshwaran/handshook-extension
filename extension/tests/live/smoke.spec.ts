import { expect, liveEventsSince, liveState, test } from './harness';

test('extension loads against the logged-in live Handshake session', async ({
  context,
  sidePanel,
  startedAt,
}) => {
  await expect(sidePanel.locator('#root')).not.toBeEmpty();

  const handshake = await context.newPage();
  await handshake.goto('https://app.joinhandshake.com/job-search', { waitUntil: 'load' });
  expect(await liveState(handshake), 'run "npm run live:login" if not "ok"').toBe('ok');

  const events = liveEventsSince(startedAt);
  expect(events.filter((event) => event.kind === 'pageerror')).toEqual([]);
  expect(events.filter((event) => event.kind === 'blocked-write')).toEqual([]);
});
