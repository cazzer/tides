import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { coldWork, type Warmup } from './ship-warmup'

// How often the scene is searched for newly loaded maps and new materials.
const RESCAN_S = 0.5

/**
 * Uploads the ship scene's maps and compiles its materials ahead of their
 * first draw, one per frame as they appear (ship-warmup.ts), so the first
 * sight of a body doesn't stall a frame on its maps' uploads (7-27 ms each
 * at 2k) and its program's link (~19 ms) (tides-01v.16). compileAsync leaves
 * the link to KHR_parallel_shader_compile, off the main thread. Mount inside
 * the ship View: its frame runs before the View renders, and three's compile
 * must not run mid-render, as it replaces the renderer's render state.
 */
export function ShipWarmup() {
  const warmed = useMemo(() => new WeakSet<object>(), [])
  const queue = useRef<Warmup[]>([])
  const scannedAt = useRef(-Infinity)

  useFrame(({ gl, scene, camera, clock }) => {
    const next = queue.current.shift()
    if (next) {
      if ('texture' in next) gl.initTexture(next.texture)
      // Skip what unmounted while it waited.
      else if (next.object.parent) void gl.compileAsync(next.object, camera, scene)
    }
    if (queue.current.length > 0 || clock.elapsedTime - scannedAt.current < RESCAN_S) return
    scannedAt.current = clock.elapsedTime
    queue.current = coldWork(scene, warmed, (material) => gl.properties.get(material))
  })

  return null
}
