// A body's sphere sized to its size on screen (tides-0oi.16). Earth, the
// Moon and the Sun draw 128×128 spheres, ~33k triangles each, which a body a
// few dozen pixels across can't show: its facets sit far under a pixel off
// the true limb. Each View picks its own level per body, by that View's
// camera, from the top segments halving down to SPHERE_LOD_MIN.
//
// Two places must always draw the top level, whatever the facets say, and
// are checked outright (topWithin), not left to the rule:
//  • Earth from at or under the cloud layer's top: the flat sheet's early
//    out (tides-0oi.3, cloud-layer.ts SHEET_GROUND_SPHERE) holds because the
//    128×128 globe encloses 0.9995 of sea level; a 64×64 one sags under it.
//  • Earth and the Sun within the ship's collision stop: the ship stops on
//    the 128×128 floor (terrain-floor.ts), and a coarser Sun's shell
//    (sunShellScale) would reach the near plane there.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { limbFacetPx, type SphereSegments } from './limb-detail'
import { offAxisScale } from './body-map-residency'
import { useViewSize } from '../use-view-size'
import { COLLISION_MARGIN } from './flight'

/** The bound on a level's facets off the true limb, device px. */
export const SPHERE_LOD_FACET_PX = 0.25

/** A coarser level is taken only once its facets are this far under the bound. */
export const SPHERE_LOD_HYSTERESIS = 1.25

/**
 * A body's altitude, as a share of its radius, under which the top level is
 * forced (topWithin) near the ship's default stop (COLLISION_MARGIN), with
 * the hysteresis's margin: the Sun's.
 */
export const STOP_TOP_LEVEL_SHARE = COLLISION_MARGIN * SPHERE_LOD_HYSTERESIS - 1

/** The coarsest level's segments, both ways. */
export const SPHERE_LOD_MIN = 32

/** `top`, then its segments halved while both stay at SPHERE_LOD_MIN or more: finest first. */
export function sphereLevels(top: SphereSegments): SphereSegments[] {
  const levels: SphereSegments[] = [top]
  for (let [width, height] = top; width / 2 >= SPHERE_LOD_MIN && height / 2 >= SPHERE_LOD_MIN; ) {
    width /= 2
    height /= 2
    levels.push([width, height])
  }
  return levels
}

const _toCentre = new THREE.Vector3()
const _forward = new THREE.Vector3()
const _eye = new THREE.Vector3()

/**
 * How far `segments`' facets stray off the limb of a sphere of
 * `worldRadius` at `centre`, drawn by `camera` over `screenPx` device rows:
 * limbFacetPx stretched by the view's off-axis scale, at the screen's corner
 * at most (and there for a centre off screen, whose limb may still show).
 * Infinity with the eye inside the sphere.
 */
export function screenFacetPx(
  segments: SphereSegments,
  camera: THREE.Camera,
  centre: THREE.Vector3,
  worldRadius: number,
  screenPx: number
): number {
  if (camera instanceof THREE.OrthographicCamera) {
    const [width, height] = segments
    const depth = 1 - Math.cos(0.5 * Math.hypot((2 * Math.PI) / width, Math.PI / height))
    return (depth * worldRadius * screenPx * camera.zoom) / (camera.top - camera.bottom)
  }
  if (!(camera instanceof THREE.PerspectiveCamera)) return Infinity
  _toCentre.subVectors(centre, _eye.setFromMatrixPosition(camera.matrixWorld))
  const distance = _toCentre.length()
  if (!(distance > worldRadius)) return Infinity
  const fov = camera.getEffectiveFOV()
  const tanHalf = Math.tan(((fov / 2) * Math.PI) / 180)
  // Just inside the corner, as offAxisScale gives 1 past it.
  const cornerCos = (1 + 1e-9) / Math.sqrt(1 + tanHalf * tanHalf * (1 + camera.aspect * camera.aspect))
  const cos = camera.getWorldDirection(_forward).dot(_toCentre) / distance
  return (
    limbFacetPx(segments, distance / worldRadius, screenPx, fov) *
    offAxisScale(Math.min(1, Math.max(cos, cornerCos)), fov, camera.aspect)
  )
}

/**
 * The level to draw from `levels` (finest first), now drawing `current`:
 * past the bound (SPHERE_LOD_FACET_PX) the coarsest finer level within it,
 * at once; else the coarsest coarser level within the bound over
 * SPHERE_LOD_HYSTERESIS, or `current`. `facetPxOf` is screenFacetPx for this
 * view, which grows as the level coarsens.
 */
export function pickSphereLevel(
  levels: readonly SphereSegments[],
  current: number,
  facetPxOf: (segments: SphereSegments) => number
): number {
  if (facetPxOf(levels[current]) > SPHERE_LOD_FACET_PX) {
    for (let i = current - 1; i > 0; i--) if (facetPxOf(levels[i]) <= SPHERE_LOD_FACET_PX) return i
    return 0
  }
  let picked = current
  for (let i = current + 1; i < levels.length; i++) {
    if (facetPxOf(levels[i]) > SPHERE_LOD_FACET_PX / SPHERE_LOD_HYSTERESIS) break
    picked = i
  }
  return picked
}

/**
 * Whether the eye `distance` from a sphere's centre of `radius` must see the
 * top level: within `topWithin` of its surface (see the header), or inside.
 */
export function forcesTopLevel(distance: number, radius: number, topWithin: number): boolean {
  return !(distance - radius > topWithin)
}

/**
 * The level useSphereLevel draws, now drawing `current`, for the eye
 * `distance` from the centre of a sphere of `radius` (its own units): the
 * top within `topWithin` of it (forcesTopLevel), whatever the facets, else
 * pickSphereLevel.
 */
export function sphereLevelFor(
  levels: readonly SphereSegments[],
  current: number,
  distance: number,
  radius: number,
  topWithin: number,
  facetPxOf: (segments: SphereSegments) => number
): number {
  return forcesTopLevel(distance, radius, topWithin) ? 0 : pickSphereLevel(levels, current, facetPxOf)
}

// The body spheres by radius and segments, shared by every View's meshes:
// a level one View drops may be the one another draws.
interface BodySphereEntry {
  sphere: THREE.BufferGeometry
  users: number
}
const bodySpheres = new Map<string, BodySphereEntry>()
const sphereKey = (radius: number, [width, height]: SphereSegments) => `${radius}:${width}x${height}`

/**
 * The shared sphere of `radius` and `segments`, built now if need be, with
 * its segments in userData.segments (EarthRenderer's displacement reads
 * them). With `shell`, one a vertex shader draws scaled out to that (the
 * Sun's, sunShellScale): culled and picked by it, and with it in
 * userData.shell for the shader's uniform. Retain it (retainBodySphere) while it may be drawn; never dispose it.
 */
export function bodySphereGeometry(radius: number, segments: SphereSegments, shell?: number): THREE.BufferGeometry {
  const key = sphereKey(radius, segments) + (shell === undefined ? '' : `@${shell}`)
  let entry = bodySpheres.get(key)
  if (!entry) {
    const sphere = new THREE.SphereGeometry(radius, segments[0], segments[1])
    sphere.userData.segments = [segments[0], segments[1]] as SphereSegments
    sphere.userData.bodySphereKey = key
    if (shell !== undefined) {
      sphere.computeBoundingSphere()
      sphere.boundingSphere!.radius *= shell
      sphere.userData.shell = shell
    }
    entry = { sphere, users: 0 }
    bodySpheres.set(key, entry)
  }
  return entry.sphere
}

/**
 * Marks `sphere` (from bodySphereGeometry) as drawn until the returned
 * release; the last release disposes it. One already disposed (StrictMode's
 * replayed effects) comes back into the cache.
 */
export function retainBodySphere(sphere: THREE.BufferGeometry): () => void {
  const key = sphere.userData.bodySphereKey as string
  let entry = bodySpheres.get(key)
  if (entry?.sphere !== sphere) {
    entry = { sphere, users: 0 }
    bodySpheres.set(key, entry)
  }
  const held = entry
  held.users++
  let released = false
  return () => {
    if (released) return
    released = true
    if (--held.users > 0) return
    held.sphere.dispose()
    if (bodySpheres.get(key) === held) bodySpheres.delete(key)
  }
}

/** How many meshes hold the shared sphere of `radius` and `segments` (tests, the perf harness). */
export function bodySphereUsers(radius: number, segments: SphereSegments): number {
  return bodySpheres.get(sphereKey(radius, segments))?.users ?? 0
}

// The body sphereLevelStep is measuring (one at a time), read by
// measuredFacetPx: no closure per frame.
const _measured = {
  camera: null as THREE.Camera | null,
  centre: new THREE.Vector3(),
  eye: new THREE.Vector3(),
  worldRadius: 0,
  screenPx: 0,
}
const measuredFacetPx = (segments: SphereSegments) =>
  screenFacetPx(segments, _measured.camera!, _measured.centre, _measured.worldRadius, _measured.screenPx)

/** From `camera`'s eye to `body`'s centre in `body`'s own units, by their world matrices. */
function eyeDistance(camera: THREE.Camera, body: THREE.Object3D): number {
  _measured.centre.setFromMatrixPosition(body.matrixWorld)
  const distance = _measured.eye.setFromMatrixPosition(camera.matrixWorld).distanceTo(_measured.centre)
  return distance / body.matrixWorld.getMaxScaleOnAxis()
}

/**
 * One frame's level for `body`'s sphere of `radius` (its own units), now at
 * `current` in `levels`, seen by `camera` over `screenPx` device rows, by
 * their world matrices as they stand: sphereLevelFor, the top within
 * `topWithin` of its surface.
 */
export function sphereLevelStep(
  levels: readonly SphereSegments[],
  current: number,
  camera: THREE.Camera,
  body: THREE.Object3D,
  radius: number,
  topWithin: number,
  screenPx: number
): number {
  const distance = eyeDistance(camera, body)
  _measured.camera = camera
  _measured.worldRadius = radius * body.matrixWorld.getMaxScaleOnAxis()
  _measured.screenPx = screenPx
  return sphereLevelFor(levels, current, distance, radius, topWithin, measuredFacetPx)
}

/**
 * At draw time, with `camera`'s and `body`'s world matrices final: whether
 * `body` (a mesh) draws a coarser level than `top` where forcesTopLevel
 * wants the top, a limb sphere aside. Then the frame's camera has jumped
 * into the band since the level was last picked, and the top must be
 * swapped in before this draw (forceTopSphere).
 */
export function drawsCoarseWhereTopForced(
  camera: THREE.Camera,
  body: THREE.Mesh,
  radius: number,
  top: SphereSegments,
  topWithin: number
): boolean {
  const segments = body.geometry.userData.segments as SphereSegments | undefined
  if (!segments || (segments[0] === top[0] && segments[1] === top[1])) return false
  return forcesTopLevel(eyeDistance(camera, body), radius, topWithin)
}

/**
 * Puts `top` on `body`, and on every mesh in its parent's tree drawing the
 * same sphere (the glow's occluder and lights), for this draw, ahead of
 * the re-render that makes it their prop too.
 */
export function forceTopSphere(body: THREE.Mesh, top: THREE.BufferGeometry): void {
  const drawn = body.geometry
  ;(body.parent ?? body).traverse((object) => {
    if ((object as THREE.Mesh).isMesh && (object as THREE.Mesh).geometry === drawn) (object as THREE.Mesh).geometry = top
  })
}

/**
 * The segments `object`'s sphere of `radius` (in its own units) draws in this
 * View: the top level on the first frame, and within `topWithin` of its
 * surface (forcesTopLevel), else pickSphereLevel by this View's camera.
 * Re-renders only on a change of level. Within `topWithin` the top is
 * drawn the frame the eye gets there: a camera that jumps in after the
 * frame callbacks, or that they measured a frame late, is caught as the
 * View's scene draws, which puts `topSphere()` on the mesh at once (the
 * flat sheet's early out decides at that moment too, cloudShaders.ts).
 */
export function useSphereLevel(
  object: RefObject<THREE.Mesh | null>,
  radius: number,
  top: SphereSegments,
  topWithin: number,
  topSphere: () => THREE.BufferGeometry
): SphereSegments {
  const [width, height] = top
  const levels = useMemo(() => sphereLevels([width, height]), [width, height])
  // The level by its index in `levels`; a new set starts at the top again.
  const [level, setLevel] = useState({ levels, index: 0 })
  const current = useRef(level)
  const viewSize = useViewSize()
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  useFrame(({ camera, size }) => {
    const body = object.current
    if (!body || levels.length === 1) return
    if (current.current.levels !== levels) current.current = { levels, index: 0 }
    // This frame's pose, as far as the callbacks before this one set it.
    camera.updateMatrixWorld()
    body.updateWorldMatrix(true, false)
    const screenPx = viewSize(size).height * gl.getPixelRatio()
    const next = sphereLevelStep(levels, current.current.index, camera, body, radius, topWithin, screenPx)
    if (next === current.current.index) return
    current.current = { levels, index: next }
    setLevel(current.current)
  })
  useEffect(() => {
    if (levels.length === 1) return
    const previous = scene.onBeforeRender
    scene.onBeforeRender = function (renderer, renderScene, camera, target) {
      previous.call(this, renderer, renderScene, camera, target)
      const body = object.current
      if (!body || !drawsCoarseWhereTopForced(camera, body, radius, [width, height], topWithin)) return
      forceTopSphere(body, topSphere())
      current.current = { levels, index: 0 }
      setLevel(current.current)
    }
    return () => {
      scene.onBeforeRender = previous
    }
  }, [scene, object, radius, width, height, topWithin, topSphere, levels])
  return levels[level.levels === levels ? level.index : 0]
}

/** The shared sphere of `radius`, `segments` and `shell` (bodySphereGeometry), retained while this component shows it. */
export function useRetainedBodySphere(radius: number, [width, height]: SphereSegments, shell?: number): THREE.BufferGeometry {
  const sphere = useMemo(() => bodySphereGeometry(radius, [width, height], shell), [radius, width, height, shell])
  useEffect(() => retainBodySphere(sphere), [sphere])
  return sphere
}
