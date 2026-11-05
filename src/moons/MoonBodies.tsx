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
import { loadBodyMap } from '../renderers/planetTextures'
import { MOONS, MOON_KEYS, isMoonKey, moonOffsetInto, moonOrientationInto, moonRadius } from './moons'
import { moonTextureUrls, type MoonTextureUrls } from './moon-textures'
import { isLowQuality } from '../quality'
import { moonRaycast, type MoonPickData } from './moon-pick'
import { useLimbBodyAmong, useLimbSphere, useWantsLimbSphere, type SphereSegments } from '../ship/limb-detail'
import {
  bodyRadiusPx,
  cachedMapProxy,
  fullMapOf,
  initialBodyMap,
  isRetiredMap,
  mapProxy,
  promoteMap,
  retireMap,
  shipMapStep,
  uploadSlot,
} from '../ship/body-map-residency'

export interface MoonBodiesProps {
  /** Which planet positions the moons follow. */
  distanceScale: DistanceScale
  /** The main panel's moons can register for camera focus, as PlanetBodies does. */
  interactive: boolean
}

// A unit sphere, scaled to each moon's radius; even the largest moon is a
// few pixels across until the camera frames it, but ship mode flies up to
// them, where a coarser one shows its facets. Shared for the app's life.
// The ship's nearest moon gets the finer limb sphere (limb-detail.ts).
const SPHERE_SEGMENTS: SphereSegments = [64, 32]
const SPHERE = new THREE.SphereGeometry(1, ...SPHERE_SEGMENTS)

// Ridged rock below the maps' resolution, as on Mercury and Mars, for a
// close pass. Not on Titan, whose map is its haze.
const MOON_DETAIL: PlanetDetail = { style: 'rock', strength: 0.25, bump: 0.08 }
const URLS = MOON_KEYS.map((key) => moonTextureUrls(key, isLowQuality()))

// The maps by JPEG url, kept for the app's life as useLoader keeps the planets',
// so a remount (planets toggled, a panel leaving the Earth's camera) shows
// them at once instead of reloading.
const loadedMaps = new Map<string, THREE.Texture>()
const pendingMaps = new Map<string, Promise<THREE.Texture>>()

function moonMap({ jpeg: url, ktx2 }: MoonTextureUrls, gl: THREE.WebGLRenderer, anisotropy: number): Promise<THREE.Texture> {
  let pending = pendingMaps.get(url)
  if (!pending) {
    pending = new Promise((resolve, reject) => loadBodyMap(url, ktx2, gl, anisotropy, resolve, reject))
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
    moonOffsetInto(key, t, mesh.position, scale)
    moonOrientationInto(key, t, mesh.quaternion)
    mesh.position.x += parent[0]
    mesh.position.y += parent[1]
    mesh.position.z += parent[2]
    ;(mesh.userData as MoonPickData).parentPosition.fromArray(parent)
  }
}

// Tells moonRaycast how tall the view is. Module level, like placeMoons.
function setViewHeight(looks: readonly { userData: MoonPickData }[], height: number) {
  for (const { userData } of looks) userData.viewHeight = height
}

// Switches a moon's material to its map (one shared compiled program for
// every textured moon). Module level, like placeMoons.
function applyMap(material: THREE.ShaderMaterial, map: THREE.Texture) {
  if (material.uniforms.uMap.value === map) return
  material.uniforms.uMap.value = map
  material.defines.USE_PLANET_MAP = ''
  material.needsUpdate = true
}

const _moonPosition = new THREE.Vector3()
const _moonScale = new THREE.Vector3()

// Ship mode (tides-0oi.7): each moon binds its map's mip-tail proxy, and the
// map is freed from the GPU, until the moon is PROMOTE_RADIUS_PX in radius;
// then its full map, for good (`promoted`, this flight's). A uniform change
// either way, so the program stays (ship/body-map-residency.ts). Module
// level, like placeMoons.
function stepMoonMaps(
  gl: THREE.WebGLRenderer,
  meshes: readonly RefObject<THREE.Mesh | null>[],
  looks: readonly { material: THREE.ShaderMaterial }[],
  promoted: WeakSet<THREE.Texture>,
  camera: THREE.PerspectiveCamera,
  screenPx: number,
  frame: number
) {
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i].current
    const uniform = looks[i].material.uniforms.uMap
    const bound = uniform.value as THREE.Texture | null
    if (!mesh || !bound) continue
    const map = fullMapOf(bound) ?? bound
    if (promoted.has(map)) continue
    mesh.getWorldPosition(_moonPosition)
    const radiusPx = bodyRadiusPx(camera, _moonPosition, mesh.getWorldScale(_moonScale).x, screenPx)
    const proxy = cachedMapProxy(map)
    const step = shipMapStep(false, radiusPx, uploadSlot.free(frame), bound !== map, proxy !== undefined)
    if (step === 'promote') {
      uploadSlot.take(frame)
      promoteMap(gl, map)
      uniform.value = map
      promoted.add(map)
    } else if (step === 'proxy' && proxy) {
      uniform.value = proxy
      retireMap(map)
    } else if (step === 'build') {
      uploadSlot.take(frame)
      const built = mapProxy(gl, map)
      if (built) {
        uniform.value = built
        retireMap(map)
      } else {
        // A map that can't have one stays as it is.
        promoted.add(map)
      }
    }
  }
}

export const MoonBodies: FC<MoonBodiesProps> = ({ distanceScale, interactive }) => {
  const { handleFocus } = useCamera() as { handleFocus: ((event: ThreeEvent<PointerEvent>) => void) | null }
  const setPlanet = useStore((s) => s.setPlanet)
  const limbMoon = useLimbBodyAmong(isMoonKey)
  const wantsLimb = useWantsLimbSphere(
    limbMoon,
    limbMoon ? moonRadius(limbMoon, distanceScale) : 1,
    SPHERE_SEGMENTS
  )
  const limbSphere = useLimbSphere(1, wantsLimb)
  const shipMode = useStore((s) => s.shipMode)
  // This flight's promoted maps (stepMoonMaps).
  const promoted = useMemo(() => new WeakSet<THREE.Texture>(), [])
  const refs = useMemo(() => MOON_KEYS.map(() => createRef<THREE.Mesh>()), [])
  const looks = useMemo(
    () =>
      MOON_KEYS.map((key, i) => {
        const sun = sunDirection()
        const loaded = loadedMaps.get(URLS[i].jpeg)
        // Its proxy while a flight has the map retired (initialBodyMap).
        const map = loaded ? initialBodyMap(loaded) : null
        const material = planetSurfaceMaterial(sun.uniform, { map })
        material.uniforms.uColor.value.set(MOONS[key].color)
        if (key !== 'titan') setPlanetDetail(material, MOON_DETAIL)
        // The camera frames a focused moon by `radius`; moonRaycast reads
        // the rest.
        const userData: MoonPickData & { focus: string } = {
          focus: key,
          radius: moonRadius(key, distanceScale),
          parentPosition: new THREE.Vector3(),
          parentRadius: positionsFor(distanceScale).radius[MOONS[key].parent],
          viewHeight: 0,
        }
        return { material, onBeforeRender: sun.onBeforeRender, userData }
      }),
    [distanceScale]
  )
  useEffect(() => () => looks.forEach(({ material }) => material.dispose()), [looks])

  // Only the main view pads taps; ship mode's moons keep the real sphere.
  const viewHeight = useThree((s) => s.size.height)
  useEffect(() => {
    setViewHeight(looks, interactive ? viewHeight : 0)
  }, [looks, interactive, viewHeight])

  // Arrived maps upload one per frame (useFrame below), up front rather than
  // when each moon first comes into view, so maps that arrive or come into
  // view together never stack their uploads into one long frame
  // (tides-2hv.18). In the system view every moon's map is resident once
  // loaded: 154 MB on desktop, 53 MB at 1k on phones; ship mode holds each
  // as its proxy instead, until the moon comes close (stepMoonMaps). The queue holds `looks`' materials, which
  // a change of distanceScale would replace, but no mounted MoonBodies sees
  // one (tides-sq9): every Scene in App.tsx passes a fixed scale ('flight'
  // for ship mode's own Scene, the 'system' default for the rest), and ship
  // mode unmounts the main panel's. Were it to happen, the new materials
  // still take every map (loadedMaps, and this effect re-queues the rest).
  const arrived = useRef<{ material: THREE.ShaderMaterial; map: THREE.Texture }[]>([])
  const gl = useThree((s) => s.gl)
  const maxAnisotropy = gl.capabilities.getMaxAnisotropy()
  useEffect(() => {
    let mounted = true
    MOON_KEYS.forEach((key, i) => {
      moonMap(URLS[i], gl, maxAnisotropy).then(
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
  }, [looks, gl, maxAnisotropy])

  // Only the main panel's camera focuses bodies; the store keys are the moons'.
  useEffect(() => {
    if (!interactive) return
    MOON_KEYS.forEach((key, i) => setPlanet(key, refs[i]))
    return () => MOON_KEYS.forEach((key) => setPlanet(key, undefined))
  }, [interactive, refs, setPlanet])

  useFrame(({ gl, camera, size, viewport }) => {
    const t = useStore.getState().timestamp
    if (t != null) placeMoons(refs, t, distanceScale)
    // Uploads and read-backs share the page's one-a-frame budget.
    const frame = gl.info.render.frame
    if (shipMode && t != null) {
      stepMoonMaps(gl, refs, looks, promoted, camera as THREE.PerspectiveCamera, size.height * viewport.dpr, frame)
    }
    const next = arrived.current[0]
    if (!next) return
    const shown = initialBodyMap(next.map)
    if (shipMode && (shown !== next.map || promoted.has(next.map))) {
      // A retired map's proxy, or a promoted map already bound: no upload.
      arrived.current.shift()
      if (!promoted.has(next.map)) applyMap(next.material, shown)
    } else if (shipMode || !isRetiredMap(next.map)) {
      // A new map's upload, one a frame as ever (system view), or within the
      // budget (ship mode, where stepMoonMaps then picks its tier).
      if (shipMode && !uploadSlot.take(frame)) return
      arrived.current.shift()
      gl.initTexture(next.map)
      applyMap(next.material, next.map)
    } else if (uploadSlot.take(frame)) {
      // Outside ship mode a map a flight retired comes back, one a frame.
      arrived.current.shift()
      promoteMap(gl, next.map)
      applyMap(next.material, next.map)
    }
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
          geometry={key === limbMoon && limbSphere ? limbSphere : SPHERE}
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
