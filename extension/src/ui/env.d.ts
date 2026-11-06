/**
 * Vite/WXT inject these standard environment flags at build time. The generated
 * WXT types only declare the WXT-specific keys, so add the ones the bridge uses
 * to decide whether mock data may be served.
 */
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}
