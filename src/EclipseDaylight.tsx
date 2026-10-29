import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from './store'
import {
  DAY_SKY,
  eclipseSkyAt,
  eclipseSkyBrightness,
  eclipseSkyVeil,
  eclipseStarVeil,
} from './eclipse-sky'

/**
 * The solar eclipse demo's daylit sky (tides-zec.1) behind the View from
 * Earth panel, which is otherwise black day and night: DAY_SKY dimmed as the
 * Sun is covered, and the stars veiled until its last sliver goes. Unmounting
 * puts the panel's own background back and lifts the veil.
 */
export function EclipseDaylight({ lat, lon }: { lat: number; lon: number }) {
  const scene = useThree((s) => s.scene)
  const color = useMemo(() => new THREE.Color(0, 0, 0), [])

  useEffect(() => takeBackground(scene, color), [scene, color])

  useFrame(() => {
    const t = useStore.getState().timestamp ?? Date.now()
    const e = eclipseSkyAt(t, lat, lon)
    color.copy(DAY_SKY).multiplyScalar(eclipseSkyBrightness(e.visible, e.sunSinAltitude))
    eclipseSkyVeil.daylight = eclipseStarVeil(e.visible, e.sunSinAltitude)
  })

  return null
}

// Outside the component: the react-hooks lint rejects mutating the scene from
// useThree in place. Returns the cleanup.
function takeBackground(scene: THREE.Scene, color: THREE.Color) {
  const previous = scene.background
  scene.background = color
  eclipseSkyVeil.active = true
  return () => {
    scene.background = previous
    eclipseSkyVeil.active = false
    eclipseSkyVeil.daylight = 0
  }
}
