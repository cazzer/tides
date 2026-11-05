import { useEffect, useSyncExternalStore } from 'react'
import { addAfterEffect, addEffect, useThree, type RootState } from '@react-three/fiber'
import type { WebGLRenderer } from 'three'
import { createAdaptiveDprState, maxDpr, stepAdaptiveDpr, type AdaptiveDprState } from '../adaptive-dpr'
import {
  createPacedDprState,
  DEFAULT_PACED_DPR_CONFIG,
  parsePacedDprConfig,
  stepPacedDpr,
  viewKindOf,
  type PacedDprChange,
  type PacedDprConfig,
  type PacedDprState,
} from '../paced-dpr'
import { createGpuFrameTimer, type GpuFrameTimer } from './gpu-frame-timer'
import { isLowQuality } from '../quality'
import { useStore } from '../store'

declare global {
  interface Window {
    /** The paced controller's config, live state and change log, when the URL has ?dprctl= (tides-0oi.13). */
    __dprctl?: { config: PacedDprConfig; state: PacedDprState | null; changes: PacedDprChange[] }
  }
}

type GetRoot = () => RootState

// The ratio AdaptivePixelRatio last set, for the root Canvas's dpr prop;
// undefined until the first change keeps R3F's default [1, 2].
let published: number | undefined
const listeners = new Set<() => void>()

function publish(dpr: number) {
  published = dpr
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** The root Canvas's dpr prop: mirrors what AdaptivePixelRatio set. */
export function usePixelRatio(): number | undefined {
  return useSyncExternalStore(subscribe, () => published)
}

export type DprControllerMode = 'paced' | 'gpu' | 'fixed'

/**
 * Which controller sets the ratio: ?dprctl=off or fixed:x pins it on either
 * tier; otherwise the low tier paces by rAF interval (paced-dpr.ts) and the
 * high tier times the GPU, or keeps R3F's default without the timer.
 */
export function dprControllerMode({
  low,
  hasTimer,
  config,
}: {
  low: boolean
  hasTimer: boolean
  config: PacedDprConfig | null
}): DprControllerMode {
  if (config && (config.off || config.fixed != null)) return 'fixed'
  if (low) return 'paced'
  return hasTimer ? 'gpu' : 'fixed'
}

/**
 * Lowers the canvas's pixel ratio while the GPU frame runs over budget and
 * raises it back when it fits (tides-nlk, adaptive-dpr.ts): flight and close
 * zoom are fill-bound and cost ~30 ms a frame at 2x on an M4 Pro, while the
 * system view costs 1.3 ms and keeps full resolution. That's the high tier;
 * the low tier (phones: no GPU timer) paces by rAF interval instead
 * (paced-dpr.ts, tides-0oi.13), and ?dprctl=off|fixed:x pins the ratio
 * (dprControllerMode). Mount once in the root Canvas, outside the Views.
 *
 * Frames are timed with a GPU timer query from R3F's global before-effect to
 * its after-effect, around every root's and View's draws. Without the timer
 * extension nothing adapts: rAF intervals are quantized to vsync and include
 * CPU time, which no resolution change would fix.
 *
 * A new ratio is applied only in the before-effect, ahead of the frame's
 * draws: setDpr resizes the drawing buffer through gl.setSize, which clears
 * the canvas, so a resize after the frame rendered would show a blank frame.
 * The root Canvas's dpr prop must mirror it (usePixelRatio): <Canvas>'s layout
 * effect calls root.configure() on every render, which would put a bare
 * setDpr back to [1, 2].
 */
export function AdaptivePixelRatio(): null {
  const gl = useThree((s) => s.gl)
  const get = useThree((s) => s.get)
  useEffect(() => {
    const config = parsePacedDprConfig(window.location.search)
    const low = isLowQuality()
    const timer = low ? null : createGpuFrameTimer(gl.getContext() as WebGL2RenderingContext)
    const mode = dprControllerMode({ low, hasTimer: timer != null, config })
    window.__dprctl = config ? { config, state: null, changes: [] } : undefined
    if (mode === 'paced') return runPaced(get, config ?? DEFAULT_PACED_DPR_CONFIG)
    if (mode === 'gpu' && timer) return runGpuTimed(gl, get, timer)
    timer?.dispose()
    if (import.meta.env.DEV && !low && !config) {
      console.info('[render] dpr fixed: no GPU timer (EXT_disjoint_timer_query_webgl2)')
    }
    return config?.fixed != null ? runFixed(get, config.fixed) : undefined
  }, [gl, get])
  return null
}

/** Applies the ratio in a before-effect, ahead of the frame's draws (setDpr clears the canvas). */
function applyDpr(get: GetRoot, dpr: number) {
  publish(dpr)
  get().setDpr(dpr)
}

function runFixed(get: GetRoot, dpr: number): () => void {
  const unsubscribe = addEffect(() => {
    if (get().viewport.dpr !== dpr) applyDpr(get, dpr)
    unsubscribe()
  })
  return unsubscribe
}

/**
 * The low tier's controller: each frame's rAF interval and the CPU time of
 * the frame before it (from the global before-effect to the after-effect,
 * around every root's and View's useFrame and draws) go to stepPacedDpr.
 */
function runPaced(get: GetRoot, config: PacedDprConfig): () => void {
  const state = createPacedDprState(window.devicePixelRatio, get().viewport.dpr, config)
  const debug = window.__dprctl
  if (debug) debug.state = state
  let pending: number | null = null
  let lastAt: number | null = null
  let cpuStart = 0
  let lastCpuMs = 0

  const unsubscribeBefore = addEffect((timestamp) => {
    if (lastAt != null) {
      const before = state.dpr
      stepPacedDpr(
        state,
        {
          at: timestamp,
          intervalMs: timestamp - lastAt,
          cpuMs: lastCpuMs,
          kind: viewKindOf(useStore.getState()),
          nativeDpr: window.devicePixelRatio,
        },
        config,
      )
      if (state.dpr !== before && state.last) {
        debug?.changes.push(state.last)
        if (import.meta.env.DEV) {
          const { from, to, reason, p95, p99, vsyncMs } = state.last
          const stats = p95 == null ? '' : ` (p95 ${p95.toFixed(1)}, p99 ${p99?.toFixed(1)}, vsync ${vsyncMs.toFixed(2)} ms)`
          console.info(`[render] dpr ${from} -> ${to} ${reason}${stats}`)
        }
      }
      if (state.dpr !== get().viewport.dpr) pending = state.dpr
    }
    lastAt = timestamp
    if (pending != null) {
      applyDpr(get, pending)
      pending = null
    }
    cpuStart = performance.now()
  })
  const unsubscribeAfter = addAfterEffect(() => {
    lastCpuMs = performance.now() - cpuStart
  })
  return () => {
    unsubscribeBefore()
    unsubscribeAfter()
  }
}

function runGpuTimed(gl: WebGLRenderer, get: GetRoot, firstTimer: GpuFrameTimer): () => void {
  let timer: GpuFrameTimer | null = firstTimer
  let state: AdaptiveDprState = createAdaptiveDprState(maxDpr(window.devicePixelRatio), get().viewport.dpr)
  let pending: number | null = null

  const unsubscribeBefore = addEffect(() => {
    if (pending != null) {
      applyDpr(get, pending)
      pending = null
    }
    timer?.begin(get().viewport.dpr)
  })
  const unsubscribeAfter = addAfterEffect(() => {
    if (!timer) return
    timer.end()
    for (const { ms, tag } of timer.poll()) {
      state = stepAdaptiveDpr(state, { at: performance.now(), ms, dpr: tag }, maxDpr(window.devicePixelRatio))
      const current = get().viewport.dpr
      if (state.dpr === current) {
        pending = null
        continue
      }
      if (pending !== state.dpr && import.meta.env.DEV) {
        const decided = state.lastMedianMs == null ? '' : ` (median ${state.lastMedianMs.toFixed(1)} ms)`
        console.info(`[render] dpr ${current} -> ${state.dpr}${decided}`)
      }
      pending = state.dpr
    }
  })

  const canvas = gl.domElement
  const onLost = () => {
    timer?.dispose()
    timer = null
  }
  const onRestored = () => {
    timer = createGpuFrameTimer(gl.getContext() as WebGL2RenderingContext)
  }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)
  return () => {
    unsubscribeBefore()
    unsubscribeAfter()
    canvas.removeEventListener('webglcontextlost', onLost)
    canvas.removeEventListener('webglcontextrestored', onRestored)
    timer?.dispose()
    timer = null
  }
}
