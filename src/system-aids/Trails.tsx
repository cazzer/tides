// Short fading motion trails behind the planets (tides-2hv.11), mounted by
// SystemAids.tsx while systemAids.trails is on (off by default): the last
// stretch of each body's orbit in sim time, so they show at any clock speed
// (see trail-buffer.ts). Moons can join once src/moons/moons.ts lands
// (tides-2hv.8). One wide-line draw for every planet.
import { useEffect, useMemo, type FC } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { earthPosition, type Vec3 } from '../ephemeris'
import { PLANETS, PLANET_KEYS, planetPosition } from '../planets'
import { useStore } from '../store'
import {
  COLORS_CHANGED,
  SEGMENTS_CHANGED,
  createTrailBuffer,
  updateTrails,
  type TrailBuffer,
  type TrailPositionAt,
} from './trail-buffer'
import type { SystemAidProps } from './types'

/**
 * Trail width, CSS pixels. [TUNE] GL lines are one device pixel, a hairline
 * on a DPR-3 phone; these are screen-space quads.
 */
export const TRAIL_WIDTH = 2 // [TUNE]

// Earth isn't in PLANETS (solar-system.tsx draws it), but it is a planet.
// Each position function is the one its body is drawn at.
const TRAIL_BODIES: readonly {
  color: string
  periodDays: number
  positionAt: (t: number) => Vec3
}[] = [
  { color: '#6b93d6', periodDays: 365.256, positionAt: earthPosition },
  ...PLANET_KEYS.map((key) => ({
    color: PLANETS[key].color,
    periodDays: PLANETS[key].period,
    positionAt: planetPosition(PLANETS[key].body),
  })),
]

const positionAt: TrailPositionAt = (body, t) => TRAIL_BODIES[body].positionAt(t)

// Linear RGB, as vertex colours are read.
const BODY_RGB = TRAIL_BODIES.map(({ color }) => {
  const { r, g, b } = new THREE.Color(color)
  return [r, g, b] as const
})

interface Trail {
  buffer: TrailBuffer
  line: LineSegments2
}

function createTrail(): Trail {
  const buffer = createTrailBuffer(
    TRAIL_BODIES.map((body) => body.periodDays),
    BODY_RGB
  )
  // Both wrap the buffer's arrays as they are, so writing those in place and
  // flagging the interleaved buffers is the whole per-frame update.
  const geometry = new LineSegmentsGeometry()
    .setPositions(buffer.segments)
    .setColors(buffer.colors)
  const material = new LineMaterial({
    vertexColors: true,
    linewidth: TRAIL_WIDTH,
    transparent: true,
    // The fade is in the colour (LineMaterial has no per-vertex alpha):
    // added onto black space it is the same as fading the opacity.
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // One endless dash: LineMaterial's way to drop its round end caps. With
    // them, each join adds two overlapping caps and the trail reads as beads.
    dashed: true,
    dashSize: 1e9,
    gapSize: 0,
  })
  const line = new LineSegments2(geometry, material)
  // Unwritten segments sit at the origin until the first frame; nothing
  // should pick a trail.
  line.frustumCulled = false
  line.raycast = () => {}
  // Before the orbit lines, which write depth along the same path: drawn
  // after them, the trail z-fights into dashes.
  line.renderOrder = -1
  return { buffer, line }
}

function interleaved(geometry: THREE.BufferGeometry, name: string): THREE.InterleavedBuffer {
  return (geometry.getAttribute(name) as THREE.InterleavedBufferAttribute).data
}

function updateTrail({ buffer, line }: Trail): void {
  const t = useStore.getState().timestamp
  if (t == null) return
  const changed = updateTrails(buffer, t, positionAt)
  if (changed & SEGMENTS_CHANGED) interleaved(line.geometry, 'instanceStart').needsUpdate = true
  if (changed & COLORS_CHANGED) interleaved(line.geometry, 'instanceColorStart').needsUpdate = true
}

export const Trails: FC<SystemAidProps> = ({ distanceScale }) => {
  // Flight spacing can follow once flight-scale.ts (tides-2hv.6) exists.
  if (distanceScale === 'flight') return null
  return <PlanetTrails />
}

function PlanetTrails() {
  const trail = useMemo(() => createTrail(), [])
  useEffect(
    () => () => {
      trail.line.geometry.dispose()
      trail.line.material.dispose()
    },
    [trail]
  )
  useFrame(() => updateTrail(trail))

  return <primitive object={trail.line} />
}
