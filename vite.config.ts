import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import commonjs from '@rollup/plugin-commonjs'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), commonjs()],
  build: {
    outDir: 'docs',
    emptyOutDir: true,
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
