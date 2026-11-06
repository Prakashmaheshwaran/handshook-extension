import { registerBackground } from '@/background/router';

export default defineBackground(() => {
  registerBackground();
  void browser.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});
