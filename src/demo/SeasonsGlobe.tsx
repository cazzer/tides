// The seasons demo's globe aid (tides-zec.3), main view only: Earth's axis,
// the point where the Sun is overhead and the readout latitude's circle.
// Mounted as a child of Earth's OrbitingBody (solar-system.tsx), so it sits in
// the tilted, spinning frame with the globe: the axis and ring are fixed in
// it, and only the dot moves, once a frame, with no allocation. The axis and
// ring are thin meshes, not lines: a one-pixel line all but vanishes over the
// lit globe on a phone.
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
const DOT_SIZE = 0.06
const DOT_LIFT = 1.01
const DOT_COLOR = '#FFD54A'
// After the globe's additive air and aurora shells, so they don't wash the
// aid out; the ground's depth still hides the far side.
const AID_RENDER_ORDER = AURORA_RENDER_ORDER + 1

function noRaycast() {}

function aidMaterial(color: string, opacity: number) {
  return new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, toneMapped: false, depthWrite: false })
}

// Module level, so the dot's mesh is moved outside the hook.
function placeDot(dot: THREE.Mesh | null, radius: number) {
  if (!dot) return
  const sun = subsolarPoint(useStore.getState().timestamp ?? Date.now())
  const { x, y, z } = calculateLocationAndRotationForLatLng(sun.lat, sun.lon, radius * DOT_LIFT).position
  dot.position.set(x, y, z)
}

export function SeasonsGlobe({ radius }: { radius: number }) {
  const location = useStore((s) => s.location)
  const { lat } = seasonsLatitude(location)
  const circle = latitudeCircle(lat, radius * RING_LIFT)
  const dot = useRef<THREE.Mesh>(null)

  const geometries = useMemo(
    () => ({
      axis: new THREE.CylinderGeometry(AXIS_WIDTH * radius, AXIS_WIDTH * radius, 2 * AXIS_LENGTH * radius, 8, 1, true),
      dot: new THREE.SphereGeometry(DOT_SIZE * radius, 16, 12),
    }),
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
  useEffect(() => () => ring.dispose(), [ring])
  useEffect(
    () => () => {
      for (const material of Object.values(materials)) material.dispose()
    },
    [materials]
  )

  useFrame(() => placeDot(dot.current, radius))

  return (
    <>
      <mesh renderOrder={AID_RENDER_ORDER} geometry={geometries.axis} material={materials.axis} raycast={noRaycast} />
      {/* The torus lies in its xy plane: turned flat, round the axis. */}
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
