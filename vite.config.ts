import { configDefaults, defineConfig } from 'vitest/config'
import path from 'path'
import react from '@vitejs/plugin-react'
import glsl from 'vite-plugin-glsl'
import { execSync } from 'child_process'

// For the unclean-exit report (src/exit-watch.ts).
function buildSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), glsl()],
  base: '/tides/',
  resolve: {
    alias: {
      'use-sync-external-store/shim/with-selector.js': path.resolve(
        process.cwd(),
        'src/shims/useSyncExternalStoreWithSelector.ts'
      ),
      'zustand/traditional': path.resolve(
        process.cwd(),
        'src/shims/zustandTraditional.ts'
      ),
    },
  },
  optimizeDeps: {
    include: ['use-sync-external-store/shim/with-selector'],
  },
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true,
      requireReturnsDefault: 'auto',
    },
  },
  test: {
    // Agent worktrees hold full copies of src/ and its tests.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha()),
    ephemeris: {},
    $ns: {},
    $e: {},
    $copy: {},
    $is: {},
    $make: {},
    $def: {},
    $assert: {},
    $moshier: {},
    $const: {},
    $processor: {},
    $julian: {},
    $util: {},
  },
})
