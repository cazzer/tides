// The harness's build and server: the app's own config plus pose hooks added
// at transform time, so the app source never carries them. The hook names match the
// perf-audit stream's hooked tree (tides-0oi.2), so pose code moves between
// the two harnesses unchanged:
//   window.__mainPose?.(camera, controls)  after the main view's controls.update()
//   window.__ship = { state, bodies, input, telemetry, earth }, then
//   window.__shipPose?.(state, earth)       after stepShip in ShipController
// plus handles the harness reads, so it works on a production build too:
//   window.__ppHandles = { getState (R3F root), THREE, addEffect, addAfterEffect, useStore, qualityTier, savedQualityChoice }
import { mergeConfig } from 'vite'
import base from '../../vite.config.ts'

const HOOKS = [
  {
    file: /\/src\/camera\.tsx$/,
    anchor: /( *)controls\.update\(\)\n(\s*\}\n\s*\}\)\n\s*useOpeningMove)/,
    replace: (_m, indent, rest) =>
      `${indent}controls.update()\n${indent};(window as any).__mainPose?.(state.camera, controls)\n${rest}`,
  },
  {
    file: /\/src\/App\.tsx$/,
    anchor: /<Canvas \{\.\.\.props\} dpr=\{usePixelRatio\(\)\} \/>/,
    prepend: `import { addEffect as __ppAddEffect, addAfterEffect as __ppAddAfterEffect } from '@react-three/fiber'\n`,
    replace: () =>
      `<Canvas {...props} dpr={usePixelRatio()} onCreated={(root) => {\n` +
      `  const w = window as any\n` +
      `  w.__ppHandles = { ...w.__ppHandles, getState: root.get, THREE, addEffect: __ppAddEffect, addAfterEffect: __ppAddAfterEffect }\n` +
      `  props.onCreated?.(root)\n` +
      `}} />`,
  },
  {
    file: /\/src\/store\.ts$/,
    anchor: /$/,
    replace: () => `\n;(window as any).__ppHandles = { ...(window as any).__ppHandles, useStore }\n`,
  },
  {
    file: /\/src\/quality\.ts$/,
    anchor: /$/,
    replace: () =>
      `\n;(window as any).__ppHandles = { ...(window as any).__ppHandles, qualityTier, savedQualityChoice }\n`,
  },
  {
    file: /\/src\/ship\/ShipController\.tsx$/,
    // One line, or (since tides-ufyr.8.3) spread over lines up to its own
    // closing paren at the call's indent.
    anchor: /( *)(stepShip\(state, shipInput, delta,[^\n]*\n|stepShip\(\n[\s\S]*?\n\1\)\n)/,
    replace: (_m, indent, line) =>
      `${indent}${line}` +
      `${indent};(window as any).__ship = { state, bodies, input: shipInput, telemetry: shipTelemetry, earth }\n` +
      `${indent};(window as any).__shipPose?.(state, earth)\n`,
  },
]

const fired = new Set()

function poseHooks() {
  let command = 'serve'
  return {
    name: 'phone-perf-pose-hooks',
    enforce: 'pre',
    configResolved(resolved) {
      command = resolved.command
    },
    // A renamed or moved file would leave its hook out without an anchor
    // error; in a build every hooked file must have been transformed.
    buildEnd(error) {
      if (error || command !== 'build') return
      const missing = HOOKS.filter((h) => !fired.has(h.file.source)).map((h) => h.file.source)
      if (missing.length) throw new Error(`phone-perf: hooked files never transformed: ${missing.join(', ')}`)
    },
    transform(code, id) {
      const path = id.split('?')[0]
      const hook = HOOKS.find((h) => h.file.test(path))
      if (!hook) return null
      if (!hook.anchor.test(code)) {
        // Fail loudly: a silently missing hook would leave every pose at its default.
        throw new Error(`phone-perf: pose hook anchor not found in ${path}; update scripts/phone-perf/vite.config.mjs`)
      }
      fired.add(hook.file.source)
      return { code: (hook.prepend ?? '') + code.replace(hook.anchor, hook.replace), map: null }
    },
  }
}

export default mergeConfig(base, {
  plugins: [poseHooks()],
  // Keep function names in the production build so profiles name real
  // functions; whitespace and syntax stay minified, so runtime cost matches
  // the deployed build closely.
  esbuild: { minifyIdentifiers: false, minifySyntax: true, minifyWhitespace: true },
  build: { minify: 'esbuild' },
  // Its own cache, so it never races the main dev server's optimizer.
  cacheDir: 'node_modules/.vite-phone-perf',
  server: {
    // Edits elsewhere in the tree must not reload a page mid-measurement.
    hmr: false,
    // Reachable from the phone over the LAN when adb reverse is not used.
    host: true,
    strictPort: true,
  },
})
