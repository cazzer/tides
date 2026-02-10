import { defineConfig } from 'vite'
import path from 'path'
import react from '@vitejs/plugin-react'
import glsl from 'vite-plugin-glsl'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), glsl()],
  base: 'tides',
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
  define: {
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
