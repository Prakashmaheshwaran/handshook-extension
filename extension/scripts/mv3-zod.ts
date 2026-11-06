import type { Plugin } from 'vite';

/**
 * Select Zod's existing interpreted parser at build time. Runtime `jitless`
 * avoids executing the compiler, but still ships Function constructors in MV3.
 * These two constant branches let the bundler remove the probe and compiler;
 * the dependency on disk and all validation semantics stay unchanged.
 */
export function mv3ZodPlugin(): Plugin {
  return {
    name: 'handshook-mv3-zod',
    enforce: 'pre',
    transform(source, id) {
      const file = id.replaceAll('\\', '/').split('?')[0];
      const branch = file?.endsWith('/node_modules/zod/v4/core/util.js')
        ? ['if (globalConfig.jitless)', 'if (true)']
        : file?.endsWith('/node_modules/zod/v4/core/schemas.js')
          ? ['const jit = !core.globalConfig.jitless;', 'const jit = false;']
          : null;
      if (!branch) return null;
      const [before, after] = branch;
      if (!before || !after || source.split(before).length !== 2) {
        throw new Error('Zod JIT implementation changed; review MV3 CSP safety before building.');
      }
      return { code: source.replace(before, after), map: null };
    },
  };
}
