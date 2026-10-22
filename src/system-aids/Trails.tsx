// Short fading motion trails behind the planets (tides-2hv.11), mounted by
// SystemAids.tsx while systemAids.trails is on (off by default). Moons can
// join once src/moons/moons.ts lands (tides-2hv.8). One LineSegments draw
// for every planet; trail-buffer.ts keeps the ring buffer it reads.
import { useEffect, useMemo, type FC } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { PLANETS, PLANET_KEYS, type PlanetKey } from '../planets'
import { useStore } from '../store'
import {
  beginTrailFrame,
  createTrailBuffer,
  fadeTrail,
  writeTrailHead,
  type TrailBuffer,
} from './trail-buffer'
import type { SystemAidProps } from './types'

// Earth isn't in PLANETS (solar-system.tsx draws it), but it is a planet.
const TRAIL_BODIES: readonly {
  key: 'earth' | PlanetKey
  color: string
  periodDays: number
}[] = [
  { key: 'earth', color: '#6b93d6', periodDays: 365.256 },
  ...PLANET_KEYS.map((key) => ({
    key,
    color: PLANETS[key].color,
    periodDays: PLANETS[key].period,
  })),
]

const PERIOD_DAYS = Float64Array.from(TRAIL_BODIES, (body) => body.periodDays)

// Linear RGB, as vertex colours are read.
const BODY_RGB = TRAIL_BODIES.map(({ color }) => {
  const { r, g, b } = new THREE.Color(color)
  return [r, g, b] as const
})

interface Trail {
  buffer: TrailBuffer
  geometry: THREE.BufferGeometry
}

function createTrail(): Trail {
  const buffer = createTrailBuffer(BODY_RGB)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(buffer.positions, 3).setUsage(THREE.DynamicDrawUsage)
  )
  geometry.setAttribute(
    'color',
    new THREE.BufferAttribute(buffer.colors, 4).setUsage(THREE.DynamicDrawUsage)
  )
  return { buffer, geometry }
}

// The planets' meshes, which OrbitingBody has already moved this frame:
// Earth and PlanetBodies mount before SystemAids, so their frame callbacks
// run first. Their local positions share this object's frame (all are
// children of SolarSystem). Zero allocation, unlike asking the ephemeris.
function updateTrail({ buffer, geometry }: Trail, now: number): void {
  const state = useStore.getState()
  const sim = state.timestamp
  if (sim == null) return
  beginTrailFrame(buffer, now, sim)
  for (let b = 0; b < TRAIL_BODIES.length; b++) {
    const mesh: THREE.Object3D | null | undefined = state[TRAIL_BODIES[b].key]?.current
    if (!mesh) continue
    const { x, y, z } = mesh.position
    writeTrailHead(buffer, b, x, y, z)
  }
  fadeTrail(buffer, now, sim, PERIOD_DAYS)
  geometry.getAttribute('position').needsUpdate = true
  geometry.getAttribute('color').needsUpdate = true
}

const trailMaterial = new THREE.LineBasicMaterial({
  vertexColors: true,
  transparent: true,
  depthWrite: false,
})

function noRaycast() {}

export const Trails: FC<SystemAidProps> = ({ distanceScale }) => {
  // Flight spacing can follow once flight-scale.ts (tides-2hv.6) exists.
  if (distanceScale === 'flight') return null
  return <PlanetTrails />
}

function PlanetTrails() {
  const trail = useMemo(() => createTrail(), [])
  useEffect(() => () => trail.geometry.dispose(), [trail])
  useFrame(({ clock }) => updateTrail(trail, clock.elapsedTime))

  return (
    <lineSegments
      geometry={trail.geometry}
      material={trailMaterial}
      // Ring slots not yet written sit at the origin; their alpha is 0.
      frustumCulled={false}
      raycast={noRaycast}
    />
  )
}
