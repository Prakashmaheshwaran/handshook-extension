import { registerContentRouter } from '@/content/router';

export default defineContentScript({
  matches: [
    'https://*.joinhandshake.com/*',
    'https://joinhandshake.com/*',
    'https://*.joinhandshake.co.uk/*',
    'https://joinhandshake.co.uk/*',
  ],
  runAt: 'document_idle',
  main() {
    if ((window as { __handshookContentReady?: boolean }).__handshookContentReady) return;
    (window as { __handshookContentReady?: boolean }).__handshookContentReady = true;
    registerContentRouter();
  },
});
