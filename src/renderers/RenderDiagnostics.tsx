import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { depthMode, depthModeDrift, logContextLoss, watchForNonFinite } from './render-diagnostics'

/**
 * Rendering tripwires (tides-2hv.1): logs WebGL context loss and restoration
 * in every build, and in dev builds console.errors the first non-finite
 * camera or object position any panel is about to draw, and logs the depth
 * mode (reversed-Z or standard, tides-zmw.9.3), console.erroring if it
 * drifts from the one the context was set up with. Mount once in the root
 * Canvas, outside the Views, so it sees every panel's renders.
 */
export function RenderDiagnostics() {
  const gl = useThree((s) => s.gl)
  const frame = useRef(0)
  const drifted = useRef(false)

  // Priority 0 at the root: counts frames without taking over rendering.
  useFrame(() => {
    frame.current++
    if (!import.meta.env.DEV || drifted.current) return
    const drift = depthModeDrift(gl)
    if (drift) {
      drifted.current = true
      console.error(`[render] ${drift}`)
    }
  })

  useEffect(() => logContextLoss(gl.domElement), [gl])
  useEffect(() => {
    if (!import.meta.env.DEV) return
    console.info(`[render] depth: ${depthMode(gl)}`)
    return watchForNonFinite(gl, () => frame.current)
  }, [gl])

  return null
}
