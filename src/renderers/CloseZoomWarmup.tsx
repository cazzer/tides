import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type * as THREE from 'three'
import { useStore } from '../store'
import { whenIdle } from '../ship/limb-detail'
import { coldWork, createWarmed, runWarmup, type Warmup } from '../ship/ship-warmup'

// How often Earth is searched for new maps and materials, once warming.
const RESCAN_S = 0.5

/**
 * Compiles the programs Earth turns to on the main view's first close zoom
 * ahead of it (tides-tvr.7.4), one per frame, as the ship's warm-up does
 * (ShipWarmup, ship-warmup.ts): the shells' inside faces (warmSides), the
 * ground's flight variant and the GIBS tile passes (the ground's
 * warmProbes), the sky-view table (the atmosphere's). Each would otherwise
 * be linked on the frame of its first draw on the way down, up to a few
 * hundred ms where the driver links at first use.
 *
 * Mount among Earth's renderers (its OrbitingBody's children, which it
 * searches, its parent's subtree), in the system scene. It runs only in the
 * main view (the one with controls, not ship mode, a perspective camera),
 * from the first idle period after Earth has drawn: the descent can start
 * anywhere inside the close-zoom range, so waiting for the eye to near
 * Earth would race it. From a frame callback, as three's compile must not
 * run mid-render.
 */
export function CloseZoomWarmup() {
  const anchor = useRef<THREE.Object3D>(null)
  const warmed = useMemo(() => createWarmed(), [])
  const queue = useRef<Warmup[]>([])
  const scannedAt = useRef(-Infinity)
  const armed = useRef<'no' | 'waiting' | 'yes'>('no')
  const cancelIdle = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      cancelIdle.current?.()
      cancelIdle.current = null
      // Asked again on a remount (StrictMode replays effects).
      if (armed.current === 'waiting') armed.current = 'no'
    },
    []
  )

  useFrame(({ gl, scene, camera, clock, controls }) => {
    const root = anchor.current?.parent
    if (!root || !controls || useStore.getState().shipMode || !(camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      return
    }
    if (armed.current !== 'yes') {
      if (armed.current === 'no' && hasDrawn(root, gl)) {
        armed.current = 'waiting'
        cancelIdle.current = whenIdle(() => {
          armed.current = 'yes'
          cancelIdle.current = null
        })
      }
      return
    }
    const materialKey = (material: THREE.Material) => gl.properties.get(material)
    const next = queue.current.shift()
    if (next) runWarmup(gl, next, camera, scene, warmed, materialKey)
    if (queue.current.length > 0 || clock.elapsedTime - scannedAt.current < RESCAN_S) return
    scannedAt.current = clock.elapsedTime
    queue.current = coldWork(root, warmed, materialKey)
  })

  return <object3D ref={anchor} />
}

// Whether any of `root`'s meshes has drawn (three holds a program for its
// material): Earth is up and its first frames are behind.
function hasDrawn(root: THREE.Object3D, gl: THREE.WebGLRenderer): boolean {
  let drawn = false
  root.traverse((object) => {
    if (drawn) return
    const { material } = object as THREE.Mesh
    if (!material || Array.isArray(material)) return
    drawn = (gl.properties.get(material) as { currentProgram?: unknown }).currentProgram !== undefined
  })
  return drawn
}
