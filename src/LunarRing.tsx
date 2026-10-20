// New, quarter and full moon glyphs on a ring inside Earth's orbit, each at
// Earth's angle on its date so lunations line up against the month names
// (tides-28u).
import * as THREE from 'three'
import { useEffect, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  GLYPH_RADIUS,
  LUNAR_RADIUS,
  QuarterCache,
  glyphOpacity,
} from './calendar-rings'
import { useStore } from './store'

// The ±178-day window holds 48 or 49 quarters.
const POOL_SIZE = 56
// The month names' grey, and the planet labels' lilac for the next event.
const BASE_COLOR = new THREE.Color('#404040')
const NEXT_COLOR = new THREE.Color('#9C98B8')
const INNER_RADIUS = 0.75 * GLYPH_RADIUS
const SEGMENTS = 32

// Lit half solid, dark half an outline, lit side on local +y: prograde,
// which is the waxing side of a first quarter. Turned by π for the last.
function quarterGeometry(): THREE.ShapeGeometry {
  const shape = new THREE.Shape().absarc(0, 0, GLYPH_RADIUS, 0, 2 * Math.PI)
  const hole = new THREE.Path()
    .moveTo(-INNER_RADIUS, 0)
    .absarc(0, 0, INNER_RADIUS, Math.PI, 2 * Math.PI)
    .closePath()
  shape.holes.push(hole)
  return new THREE.ShapeGeometry(shape, SEGMENTS / 2)
}

/** Indexed by moon quarter: new, first, full, last. */
function glyphGeometries(): THREE.BufferGeometry[] {
  const quarter = quarterGeometry()
  return [
    new THREE.RingGeometry(INNER_RADIUS, GLYPH_RADIUS, SEGMENTS),
    quarter,
    new THREE.CircleGeometry(GLYPH_RADIUS, SEGMENTS),
    quarter,
  ]
}

function glyphPool(geometry: THREE.BufferGeometry): THREE.Mesh[] {
  return Array.from({ length: POOL_SIZE }, () => {
    const mesh = new THREE.Mesh(
      geometry,
      // Depth-tested like the month labels so bodies hide glyphs behind them.
      new THREE.MeshBasicMaterial({
        color: BASE_COLOR,
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
      })
    )
    mesh.visible = false
    return mesh
  })
}

// Unset until SimClock's first frame, which starts from Date.now().
function simTime(): number {
  return useStore.getState().timestamp ?? Date.now()
}

export function LunarRing() {
  const [cache] = useState(() => new QuarterCache())
  const [geometries] = useState(glyphGeometries)
  const [meshes] = useState(() => glyphPool(geometries[0]))

  useEffect(
    () => () => {
      new Set(geometries).forEach((g) => g.dispose())
      meshes.forEach((m) => (m.material as THREE.Material).dispose())
    },
    [geometries, meshes]
  )

  useFrame(() => {
    const now = simTime()
    cache.update(now)
    let slot = 0
    let foundNext = false
    // Events are in time order, so the first one ahead is the next.
    for (const event of cache.events) {
      if (slot === POOL_SIZE) break
      const dt = event.t - now
      const opacity = glyphOpacity(dt)
      if (opacity <= 0) continue
      const isNext = !foundNext && dt > 0
      if (isNext) foundNext = true

      const mesh = meshes[slot++]
      const material = mesh.material as THREE.MeshBasicMaterial
      mesh.visible = true
      mesh.geometry = geometries[event.quarter]
      mesh.position.set(
        LUNAR_RADIUS * Math.cos(event.angle),
        0,
        -LUNAR_RADIUS * Math.sin(event.angle)
      )
      // Local +x radial, +y prograde, facing up (as the month labels).
      mesh.rotation.set(
        -Math.PI / 2,
        0,
        event.angle + (event.quarter === 3 ? Math.PI : 0)
      )
      material.opacity = opacity
      material.color.copy(isNext ? NEXT_COLOR : BASE_COLOR)
    }
    for (; slot < POOL_SIZE; slot++) meshes[slot].visible = false
  })

  return (
    <group>
      {meshes.map((mesh, i) => (
        <primitive
          key={i}
          object={mesh}
        />
      ))}
    </group>
  )
}
