import { useEffect, useSyncExternalStore } from 'react'
import { addAfterEffect, addEffect, useThree } from '@react-three/fiber'
import { createAdaptiveDprState, maxDpr, stepAdaptiveDpr, type AdaptiveDprState } from '../adaptive-dpr'
import { createGpuFrameTimer, type GpuFrameTimer } from './gpu-frame-timer'
import { isLowQuality } from '../quality'

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

/**
 * Lowers the canvas's pixel ratio while the GPU frame runs over budget and
 * raises it back when it fits (tides-nlk, adaptive-dpr.ts): flight and close
 * zoom are fill-bound and cost ~30 ms a frame at 2x on an M4 Pro, while the
 * system view costs 1.3 ms and keeps full resolution. High tier only; the low
 * tier keeps R3F's default. Mount once in the root Canvas, outside the Views.
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
    if (isLowQuality()) return
    const context = gl.getContext() as WebGL2RenderingContext
    let timer: GpuFrameTimer | null = createGpuFrameTimer(context)
    if (!timer) {
      if (import.meta.env.DEV) console.info('[render] dpr fixed: no GPU timer (EXT_disjoint_timer_query_webgl2)')
      return
    }
    let state: AdaptiveDprState = createAdaptiveDprState(maxDpr(window.devicePixelRatio), get().viewport.dpr)
    let pending: number | null = null

    const unsubscribeBefore = addEffect(() => {
      if (pending != null) {
        publish(pending)
        get().setDpr(pending)
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
  }, [gl, get])
  return null
}
