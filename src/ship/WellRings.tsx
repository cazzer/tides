// The gravity wells' rings in ship mode (tides-h6a; see well-rings.ts): each
// body's well edge as a brighter ring and, for the nearest body and the
// locked target, its slowdown band's edge as a faint dashed one, each the
// outline of its sphere from where the ship is. Mount inside the ship View
// after ShipController and ShipTargeting, so each frame reads the camera
// where the ship now is and this frame's nearest body.
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../store'
import { positionsFor, type BodyKey } from '../flight-scale'
import { PLANETS, PLANET_KEYS } from '../planets'
import { MOON_KEYS, MOONS, moonPosition, moonRadius } from '../moons/moons'
import { BODY_MASS_KG } from './ship-bodies'
import { getShipTarget, shipTelemetry } from './ship-telemetry'
import { isMoonBody } from './ship-targeting'
import {
  INNER_RING_OPACITY,
  MOON_RING_OPACITY,
  OUTER_RING_OPACITY,
  placeRing,
  ringParent,
  ringStrength,
  showsOuter,
  wellRings,
  type RingBody,
  type Rings,
} from './well-rings'

// As ShipTargeting: at 1× bodies barely move between refreshes.
const BODY_REFRESH_MS = 250
const RING_SEGMENTS = 160
// Dash and gap along the unit circle (2π round): ~50 dashes whatever its size.
const DASH = 0.07

// Earth's ocean blue, as its marker dot (BodyMarkers.tsx); the Sun's a warm
// white; moons a pale grey, as they have no colour of their own.
const EARTH_COLOR = '#4f8fe0'
const SUN_COLOR = '#ffe2a8'
const MOON_COLOR = '#c8d2dc'

interface Ring {
  body: RingBody
  /** Index of its ringParent in the list, or −1. */
  parent: number
  positionAt: (t: number) => readonly number[]
  rings: Rings
  inner: THREE.LineLoop
  outer: THREE.LineLoop
}

function simTime(): number {
  return useStore.getState().timestamp ?? Date.now()
}

function noRaycast() {}

function loop(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.LineLoop {
  const line = new THREE.LineLoop(geometry, material)
  line.raycast = noRaycast
  line.frustumCulled = false
  line.visible = false
  return line
}

function createRings(geometry: THREE.BufferGeometry): Ring[] {
  const { positionAt, radius } = positionsFor('flight')
  const entries: { key: string; radius: number; mass: number; color: string; positionAt: (t: number) => readonly number[] }[] = [
    { key: 'sun', radius: radius.sun, mass: BODY_MASS_KG.sun, color: SUN_COLOR, positionAt: positionAt.sun },
    { key: 'earth', radius: radius.earth, mass: BODY_MASS_KG.earth, color: EARTH_COLOR, positionAt: positionAt.earth },
    { key: 'moon', radius: radius.moon, mass: BODY_MASS_KG.moon, color: MOON_COLOR, positionAt: positionAt.moon },
    ...PLANET_KEYS.map((key) => ({
      key,
      radius: radius[key as BodyKey],
      mass: BODY_MASS_KG[key],
      color: PLANETS[key].color,
      positionAt: positionAt[key],
    })),
    ...MOON_KEYS.map((key) => ({
      key,
      radius: moonRadius(key, 'flight'),
      mass: MOONS[key].massKg,
      color: MOON_COLOR,
      positionAt: (t: number) => moonPosition(key, t, 'flight'),
    })),
  ]
  const keys = entries.map((e) => e.key)
  return entries.map((e) => {
    const parentKey = ringParent(e.key)
    const solid = new THREE.LineBasicMaterial({
      color: e.color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
    const dashed = new THREE.LineDashedMaterial({
      color: e.color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      dashSize: DASH,
      gapSize: DASH,
    })
    return {
      body: { key: e.key, position: new THREE.Vector3(), radius: e.radius, mass: e.mass },
      parent: parentKey ? keys.indexOf(parentKey) : -1,
      positionAt: e.positionAt,
      rings: { inner: NaN, outer: NaN },
      inner: loop(geometry, solid),
      outer: loop(geometry, dashed),
    }
  })
}

function unitCircle(): THREE.BufferGeometry {
  const points = Array.from({ length: RING_SEGMENTS }, (_, i) => {
    const a = (i / RING_SEGMENTS) * Math.PI * 2
    return new THREE.Vector3(Math.cos(a), Math.sin(a), 0)
  })
  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  // LineDashedMaterial reads lineDistance; a closing segment back to the
  // start is LineLoop's own, so the pattern is measured over the points.
  const distances = new Float32Array(RING_SEGMENTS)
  for (let i = 1; i < RING_SEGMENTS; i++) distances[i] = distances[i - 1] + points[i].distanceTo(points[i - 1])
  geometry.setAttribute('lineDistance', new THREE.BufferAttribute(distances, 1))
  return geometry
}

function show(line: THREE.LineLoop, centre: THREE.Vector3, radius: number, eye: THREE.Vector3, strength: number, opacity: number): void {
  line.visible = strength > 0
  if (!line.visible) return
  placeRing(line, centre, radius, eye)
  ;(line.material as THREE.LineBasicMaterial).opacity = opacity * strength
}

export function WellRings() {
  const geometry = useMemo(unitCircle, [])
  const rings = useMemo(() => createRings(geometry), [geometry])
  const group = useRef<THREE.Group>(null)
  const bodiesAt = useRef<number | null>(null)

  useEffect(() => {
    const g = group.current
    if (!g) return
    for (const r of rings) g.add(r.inner, r.outer)
    return () => {
      for (const r of rings) {
        g.remove(r.inner, r.outer)
        ;(r.inner.material as THREE.Material).dispose()
        ;(r.outer.material as THREE.Material).dispose()
      }
      geometry.dispose()
    }
  }, [rings, geometry])

  useFrame(({ camera, size }) => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return
    const t = simTime()
    if (bodiesAt.current == null || Math.abs(t - bodiesAt.current) >= BODY_REFRESH_MS) {
      for (const r of rings) r.body.position.fromArray(r.positionAt(t))
      for (const r of rings) wellRings(r.body, r.parent >= 0 ? rings[r.parent].body : null, r.rings)
      bodiesAt.current = t
    }
    const eye = camera.position
    const fov = THREE.MathUtils.degToRad(camera.fov)
    const nearest = shipTelemetry.nearest.key
    const target = getShipTarget()
    for (const r of rings) {
      const d = eye.distanceTo(r.body.position)
      const { inner, outer } = r.rings
      const opacity = isMoonBody(r.body.key) ? MOON_RING_OPACITY : INNER_RING_OPACITY
      show(r.inner, r.body.position, inner, eye, ringStrength(inner, d, fov, size.height), opacity)
      const outerStrength = showsOuter(r.body.key, nearest, target) ? ringStrength(outer, d, fov, size.height) : 0
      show(r.outer, r.body.position, outer, eye, outerStrength, OUTER_RING_OPACITY)
    }
  })

  return <group ref={group} />
}
