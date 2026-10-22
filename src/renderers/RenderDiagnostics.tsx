import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { logContextLoss, watchForNonFinite } from './render-diagnostics'

/**
 * Rendering tripwires (tides-2hv.1): logs WebGL context loss and restoration
 * in every build, and in dev builds console.errors the first non-finite
 * camera or object position any panel is about to draw. Mount once in the
 * root Canvas, outside the Views, so it sees every panel's renders.
 */
export function RenderDiagnostics() {
  const gl = useThree((s) => s.gl)
  const frame = useRef(0)

  // Priority 0 at the root: counts frames without taking over rendering.
  useFrame(() => {
    frame.current++
  })

  useEffect(() => logContextLoss(gl.domElement), [gl])
  useEffect(() => {
    if (!import.meta.env.DEV) return
    return watchForNonFinite(gl, () => frame.current)
  }, [gl])

  return null
}
