import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { mv3ZodPlugin } from './scripts/mv3-zod';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  publicDir: 'src/public',
  vite: () => ({
    plugins: [tailwindcss(), mv3ZodPlugin()],
  }),
  manifest: {
    name: 'Handshook',
    description:
      'Apply to Handshake jobs with your existing session, documents, and saved answers. Automation is on by default; you stay in control.',
    version: '1.1.4',
    minimum_chrome_version: '120',
    permissions: ['storage', 'alarms'],
    host_permissions: [
      'https://*.joinhandshake.com/*',
      'https://joinhandshake.com/*',
      'https://*.joinhandshake.co.uk/*',
      'https://joinhandshake.co.uk/*',
    ],
    optional_host_permissions: ['https://openrouter.ai/*'],
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
    },
    action: {
      default_title: 'Open Handshook',
      default_icon: {
        16: 'icon-action-16.png',
        32: 'icon-action-32.png',
        48: 'icon-action-48.png',
      },
    },
  },
});
