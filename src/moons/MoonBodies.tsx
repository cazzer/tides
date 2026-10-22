// The major moons of Mars and the outer planets (tides-2hv.8; positions and
// data in moons.ts). SolarSystem mounts this beside PlanetBodies, in the
// orbital views only; Earth's Moon stays in solar-system.tsx.
//
// Nineteen small spheres, so the cost stays trivial: one shared low-poly
// geometry scaled per moon, one material per moon (they share the planets'
// compiled program, lit the same way, from the Sun's actual direction), and
// one useFrame that places them all without allocating.
//
// Each moon starts as its catalog colour and picks up its surface map
// (moon-textures.ts) when that arrives, so the maps never hold up the view.
// Every moon is turned tidally locked, longitude 0 toward its parent
// (moonOrientationInto).
import { createRef, useEffect, useMemo, useRef, type FC, type RefObject } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import type { DistanceScale } from '../distance-scale'
import { positionsFor } from '../flight-scale'
import { useCamera } from '../camera'
import { useStore } from '../store'
import {
  planetSurfaceMaterial,
  setPlanetDetail,
  sunDirection,
  type PlanetDetail,
} from '../renderers/planetMaterials'
import { loadColorTexture } from '../renderers/planetTextures'
import { PLANETS } from '../planets'
import { MOONS, MOON_KEYS, moonOffsetInto, moonOrientationInto, moonRadius } from './moons'
import { moonTextureUrl } from './moon-textures'
import { isLowQuality } from '../quality'
import { moonRaycast, type MoonPickData } from './moon-pick'

export interface MoonBodiesProps {
  /** Which planet positions the moons follow. */
  distanceScale: DistanceScale
  /** The main panel's moons can register for camera focus, as PlanetBodies does. */
  interactive: boolean
}

// A unit sphere, scaled to each moon's radius; even the largest moon is a
// few pixels across until the camera frames it, but ship mode flies up to
// them, where a coarser one shows its facets. Shared for the app's life.
const SPHERE = new THREE.SphereGeometry(1, 64, 32)

// Ridged rock below the maps' resolution, as on Mercury and Mars, for a
// close pass. Not on Titan, whose map is its haze.
const MOON_DETAIL: PlanetDetail = { style: 'rock', strength: 0.25, bump: 0.08 }
const URLS = MOON_KEYS.map((key) => moonTextureUrl(key, isLowQuality()))

// The maps by url, kept for the app's life as useLoader keeps the planets',
// so a remount (planets toggled, a panel leaving the Earth's camera) shows
// them at once instead of reloading.
const loadedMaps = new Map<string, THREE.Texture>()
const pendingMaps = new Map<string, Promise<THREE.Texture>>()

function moonMap(url: string, anisotropy: number): Promise<THREE.Texture> {
  let pending = pendingMaps.get(url)
  if (!pending) {
    pending = new Promise((resolve, reject) => loadColorTexture(url, anisotropy, resolve, reject))
    pending.then(
      (map) => loadedMaps.set(url, map),
      () => pendingMaps.delete(url)
    )
    pendingMaps.set(url, pending)
  }
  return pending
}

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
    moonOrientationInto(key, t, mesh.quaternion)
    mesh.position.x += parent[0]
    mesh.position.y += parent[1]
    mesh.position.z += parent[2]
    ;(mesh.userData as MoonPickData).parentPosition.fromArray(parent)
  }
}

// Switches a moon's material to its map (one shared compiled program for
// every textured moon). Module level, like placeMoons.
function applyMap(material: THREE.ShaderMaterial, map: THREE.Texture) {
  if (material.uniforms.uMap.value === map) return
  material.uniforms.uMap.value = map
  material.defines.USE_PLANET_MAP = ''
  material.needsUpdate = true
}

export const MoonBodies: FC<MoonBodiesProps> = ({ distanceScale, interactive }) => {
  const { handleFocus } = useCamera() as { handleFocus: ((event: ThreeEvent<PointerEvent>) => void) | null }
  const setPlanet = useStore((s) => s.setPlanet)
  const refs = useMemo(() => MOON_KEYS.map(() => createRef<THREE.Mesh>()), [])
  const looks = useMemo(
    () =>
      MOON_KEYS.map((key, i) => {
        const sun = sunDirection()
        const material = planetSurfaceMaterial(sun.uniform, { map: loadedMaps.get(URLS[i]) ?? null })
        material.uniforms.uColor.value.set(MOONS[key].color)
        if (key !== 'titan') setPlanetDetail(material, MOON_DETAIL)
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

  // Arrived maps upload one per frame (useFrame below), up front rather than
  // when each moon first comes into view, so maps that arrive or come into
  // view together never stack their uploads into one long frame
  // (tides-2hv.18). Every moon's map is resident once loaded: 154 MB on
  // desktop, 53 MB at 1k on phones.
  const arrived = useRef<{ material: THREE.ShaderMaterial; map: THREE.Texture }[]>([])
  const maxAnisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy())
  useEffect(() => {
    let mounted = true
    MOON_KEYS.forEach((key, i) => {
      moonMap(URLS[i], maxAnisotropy).then(
        (map) => {
          if (mounted) arrived.current.push({ material: looks[i].material, map })
        },
        // The moon keeps its catalog colour.
        (err) => console.warn(`Moon texture for ${key} failed to load`, err)
      )
    })
    return () => {
      mounted = false
    }
  }, [looks, maxAnisotropy])

  // Only the main panel's camera focuses bodies; the store keys are the moons'.
  useEffect(() => {
    if (!interactive) return
    MOON_KEYS.forEach((key, i) => setPlanet(key, refs[i]))
    return () => MOON_KEYS.forEach((key) => setPlanet(key, undefined))
  }, [interactive, refs, setPlanet])

  useFrame(({ gl }) => {
    const next = arrived.current.shift()
    if (next) {
      gl.initTexture(next.map)
      applyMap(next.material, next.map)
    }
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
