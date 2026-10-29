// The seasons demo's globe aid (tides-zec.3), main view only: Earth's axis,
// the point where the Sun is overhead, the readout latitude's circle and a
// faint equator to measure the dot against. Mounted as a child of Earth's
// OrbitingBody (solar-system.tsx), so it sits in the tilted, spinning frame
// with the globe: the axis and rings are fixed in it, and only the dot moves,
// re-placed when the clock has moved. The axis and rings are thin meshes, not
// lines: a one-pixel line all but vanishes over the lit globe on a phone.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { subsolarPoint } from '../geo-clouds'
import { AURORA_RENDER_ORDER } from '../renderers/earth-shells'
import { useStore } from '../store'
import { calculateLocationAndRotationForLatLng } from '../utils'
import { latitudeCircle, seasonsLatitude } from './seasons'

// Sizes are × Earth's radius.
const AXIS_LENGTH = 1.4 // each way
const AXIS_WIDTH = 0.008
const AXIS_OPACITY = 0.8
const RING_LIFT = 1.012 // the tube's centre, clear of the ground
const RING_WIDTH = 0.008
const RING_COLOR = '#7FD6FF'
const RING_OPACITY = 0.9
const EQUATOR_OPACITY = 0.3
const DOT_SIZE = 0.06
const DOT_LIFT = 1.01
const DOT_COLOR = '#FFD54A'
// After the globe's additive air and aurora shells, so they don't wash the
// aid out; the ground's depth still hides the far side. Every material is
// transparent, the dot's too: three draws opaque meshes before all
// transparent ones, whatever their renderOrder.
const AID_RENDER_ORDER = AURORA_RENDER_ORDER + 1

function noRaycast() {}

function aidMaterial(color: string, opacity: number) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, toneMapped: false, depthWrite: false })
}

// Module level, so the dot's mesh is moved outside the hook. subsolarPoint
// returns a small object, so it runs only when the clock has moved.
function placeDot(dot: THREE.Mesh | null, placedAt: { t: number }, radius: number) {
  const t = useStore.getState().timestamp ?? Date.now()
  if (!dot || t === placedAt.t) return
  placedAt.t = t
  const sun = subsolarPoint(t)
  const { x, y, z } = calculateLocationAndRotationForLatLng(sun.lat, sun.lon, radius * DOT_LIFT).position
  dot.position.set(x, y, z)
}

export function SeasonsGlobe({ radius }: { radius: number }) {
  const location = useStore((s) => s.location)
  const { lat } = seasonsLatitude(location)
  const circle = latitudeCircle(lat, radius * RING_LIFT)
  const dot = useRef<THREE.Mesh>(null)
  const placedAt = useMemo(() => ({ t: NaN }), [])

  const geometries = useMemo(
    () => ({
      axis: new THREE.CylinderGeometry(AXIS_WIDTH * radius, AXIS_WIDTH * radius, 2 * AXIS_LENGTH * radius, 8, 1, true),
      dot: new THREE.SphereGeometry(DOT_SIZE * radius, 16, 12),
    }),
    [radius]
  )
  const equator = useMemo(
    () => new THREE.TorusGeometry(RING_LIFT * radius, RING_WIDTH * radius, 6, 128),
    [radius]
  )
  // Its own memo: a new pin rebuilds only the ring.
  const ring = useMemo(
    () => new THREE.TorusGeometry(circle.radius, RING_WIDTH * radius, 6, 128),
    [circle.radius, radius]
  )
  const materials = useMemo(
    () => ({
      axis: aidMaterial('#FFFFFF', AXIS_OPACITY),
      ring: aidMaterial(RING_COLOR, RING_OPACITY),
      equator: aidMaterial('#FFFFFF', EQUATOR_OPACITY),
      dot: aidMaterial(DOT_COLOR, 1),
    }),
    []
  )

  useEffect(
    () => () => {
      for (const geometry of Object.values(geometries)) geometry.dispose()
    },
    [geometries]
  )
  useEffect(() => () => equator.dispose(), [equator])
  useEffect(() => () => ring.dispose(), [ring])
  useEffect(
    () => () => {
      for (const material of Object.values(materials)) material.dispose()
    },
    [materials]
  )

  useFrame(() => placeDot(dot.current, placedAt, radius))

  return (
    <>
      <mesh renderOrder={AID_RENDER_ORDER} geometry={geometries.axis} material={materials.axis} raycast={noRaycast} />
      {/* A torus lies in its xy plane: turned flat, round the axis. */}
      <mesh
        renderOrder={AID_RENDER_ORDER}
        rotation-x={Math.PI / 2}
        geometry={equator}
        material={materials.equator}
        raycast={noRaycast}
      />
      <mesh
        renderOrder={AID_RENDER_ORDER}
        position-y={circle.y}
        rotation-x={Math.PI / 2}
        geometry={ring}
        material={materials.ring}
        raycast={noRaycast}
      />
      <mesh ref={dot} renderOrder={AID_RENDER_ORDER} geometry={geometries.dot} material={materials.dot} raycast={noRaycast} />
    </>
  )
}
