// The major moons of Mars and the outer planets (tides-2hv.8; positions and
// data in moons.ts). SolarSystem mounts this beside PlanetBodies, in the
// orbital views only; Earth's Moon stays in solar-system.tsx.
//
// Nineteen small spheres, so the cost stays trivial: one shared low-poly
// geometry scaled per moon, one material per moon (they share the planets'
// compiled program, lit the same way, from the Sun's actual direction), and
// one useFrame that places them all without allocating.
import { createRef, useEffect, useMemo, type FC, type RefObject } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import type { DistanceScale } from '../distance-scale'
import { positionsFor } from '../flight-scale'
import { useCamera } from '../camera'
import { useStore } from '../store'
import { planetSurfaceMaterial, sunDirection } from '../renderers/planetMaterials'
import { PLANETS } from '../planets'
import { MOONS, MOON_KEYS, moonOffsetInto, moonRadius } from './moons'
import { moonRaycast, type MoonPickData } from './moon-pick'

export interface MoonBodiesProps {
  /** Which planet positions the moons follow. */
  distanceScale: DistanceScale
  /** The main panel's moons can register for camera focus, as PlanetBodies does. */
  interactive: boolean
}

// A unit sphere, scaled to each moon's radius; even the largest moon is a
// few pixels across until the camera frames it. Shared for the app's life.
const SPHERE = new THREE.SphereGeometry(1, 32, 16)

// Each moon at its parent's position at `scale` plus its offset. Module
// level, so the meshes behind the memoised refs aren't mutated in a hook.
function placeMoons(meshes: readonly RefObject<THREE.Mesh | null>[], t: number, scale: DistanceScale) {
  const { positionAt } = positionsFor(scale)
  for (let i = 0; i < MOON_KEYS.length; i++) {
    const mesh = meshes[i].current
    if (!mesh) continue
    const key = MOON_KEYS[i]
    const parent = positionAt[MOONS[key].parent](t)
    moonOffsetInto(key, t, mesh.position)
    mesh.position.x += parent[0]
    mesh.position.y += parent[1]
    mesh.position.z += parent[2]
    ;(mesh.userData as MoonPickData).parentPosition.fromArray(parent)
  }
}

export const MoonBodies: FC<MoonBodiesProps> = ({ distanceScale, interactive }) => {
  const { handleFocus } = useCamera() as { handleFocus: ((event: ThreeEvent<PointerEvent>) => void) | null }
  const setPlanet = useStore((s) => s.setPlanet)
  const refs = useMemo(() => MOON_KEYS.map(() => createRef<THREE.Mesh>()), [])
  const looks = useMemo(
    () =>
      MOON_KEYS.map((key) => {
        const sun = sunDirection()
        const material = planetSurfaceMaterial(sun.uniform)
        material.uniforms.uColor.value.set(MOONS[key].color)
        // The camera frames a focused moon by `radius`; moonRaycast reads
        // the rest.
        const userData: MoonPickData & { focus: string } = {
          focus: key,
          radius: moonRadius(key),
          parentPosition: new THREE.Vector3(),
          parentRadius: PLANETS[MOONS[key].parent].radius,
        }
        return { material, onBeforeRender: sun.onBeforeRender, userData }
      }),
    []
  )
  useEffect(() => () => looks.forEach(({ material }) => material.dispose()), [looks])

  // Only the main panel's camera focuses bodies; the store keys are the moons'.
  useEffect(() => {
    if (!interactive) return
    MOON_KEYS.forEach((key, i) => setPlanet(key, refs[i]))
    return () => MOON_KEYS.forEach((key) => setPlanet(key, undefined))
  }, [interactive, refs, setPlanet])

  useFrame(() => {
    const t = useStore.getState().timestamp
    if (t != null) placeMoons(refs, t, distanceScale)
  })

  const onPointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation()
    if (interactive) handleFocus?.(event)
  }

  return (
    <>
      {MOON_KEYS.map((key, i) => (
        <mesh
          key={key}
          ref={refs[i]}
          geometry={SPHERE}
          material={looks[i].material}
          scale={looks[i].userData.radius}
          userData={looks[i].userData}
          raycast={moonRaycast}
          onBeforeRender={looks[i].onBeforeRender}
          onPointerDown={onPointerDown}
        />
      ))}
    </>
  )
}
