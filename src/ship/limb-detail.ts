// The nearest body's limb in flight (tides-01v.5). A body's sphere is a
// polyhedron inscribed in it, so its silhouette dips between vertices: from
// the ship's collision stop the limb is only ~0.2 R away, and a 128-segment
// sphere's facets show as ~3 px notches on a 1600 px tall screen (a 64×32
// moon's as ~16 px). Only the nearest body is ever that close, so only it
// trades up to LIMB_SEGMENTS, and only once its own sphere's facets would
// show (tides-01v.11); every other body keeps its own, cheaper sphere.

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import type { Body } from './flight'

/** Width and height segments of a SphereGeometry. */
export type SphereSegments = readonly [width: number, height: number]

/**
 * The nearest body's sphere: square cells (2π/512 both ways), whose facets
 * stay under 1 px at every collision stop on a 1600 px tall screen, even in
 * its corners (limbFacetPx; measured ≤ 0.75 px from 1.02 R).
 */
export const LIMB_SEGMENTS: SphereSegments = [512, 256]

/**
 * Estimate of how far a sphere's faceted silhouette strays from the true
 * limb, in screen pixels at the screen's centre (headless measurements run
 * up to ~1.3× this), seen from `eyeOverR` of the
 * sphere's radii out by a camera with `fovDeg` vertical FOV over `screenPx`
 * rows. A cell's centre (its widest, at the equator) sits deepest below the
 * sphere; lowering the surface by that much moves the tangent ray by the
 * change in the limb's angular radius.
 */
export function limbFacetPx(
  [width, height]: SphereSegments,
  eyeOverR: number,
  screenPx: number,
  fovDeg: number
): number {
  const halfDiagonal = 0.5 * Math.hypot((2 * Math.PI) / width, Math.PI / height)
  const depth = 1 - Math.cos(halfDiagonal)
  const angle = Math.asin(1 / eyeOverR) - Math.asin((1 - depth) / eyeOverR)
  const pxPerRadian = screenPx / 2 / Math.tan(((fovDeg / 2) * Math.PI) / 180)
  return angle * pxPerRadian
}

/**
 * A body's sphere trades up to LIMB_SEGMENTS once its own segments' facets
 * would stand this far off the limb (limbFacetPx, at the screen's centre).
 * Further out the base sphere's facets are subpixel and the fine one is waste:
 * the Sun mid-cruise, or a planet a few radii off.
 */
export const LIMB_FACET_PX = 0.5

// The view only moves on once the gap to the limb body's surface has grown
// or shrunk by this factor, and a newly nearest body only takes over once it
// is this much closer than the held one: hysteresis, so a ship hovering at a
// facet threshold, or at the midpoint between a planet and its moon, doesn't
// flip spheres every frame. It also keeps the store from changing per frame.
export const LIMB_HYSTERESIS = 1.05

/**
 * The least gap the hysteresis measures, scene units (~216 m true): at
 * Earth's true-scale stop over the sea (30 m, tides-zmw.9.8) 5% of the gap
 * is a metre and a half, which the floor's settling would cross every few
 * frames, each a store notification. The facets never care that close.
 */
export const LIMB_GAP_FLOOR = 1e-4

interface LimbView {
  key: string
  /** From the eye to the body's centre. */
  distance: number
  /** The body's drawn radius, for the gap the hysteresis measures. */
  radius: number
  screenPx: number
  fovDeg: number
}

// The ship's limb body, set by ShipController while ship mode runs and null
// otherwise. Ship mode and the main view never mount together, so outside
// ship mode no body changes.
let view: LimbView | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

const gapRatio = (a: number, b: number) => Math.max(a, LIMB_GAP_FLOOR) / Math.max(b, LIMB_GAP_FLOOR)

/**
 * ShipController's per-frame report: the nearest body (`nearestKey`, from
 * telemetry) seen from `eye` over `screenPx` device rows with a `fovDeg`
 * vertical FOV. Listeners hear only changes past LIMB_HYSTERESIS.
 */
export function updateLimbView(
  nearestKey: string | null,
  bodies: readonly Body[],
  eye: THREE.Vector3,
  screenPx: number,
  fovDeg: number
): void {
  let body = nearestKey == null ? undefined : bodies.find((b) => b.key === nearestKey)
  if (!body) return clearLimbView()
  const held = view && view.key !== body.key ? bodies.find((b) => b.key === view?.key) : undefined
  const gap = (b: Body) => b.position.distanceTo(eye) - b.radius
  if (held && gapRatio(gap(held), gap(body)) < LIMB_HYSTERESIS) body = held
  const distance = body.position.distanceTo(eye)
  if (
    view &&
    view.key === body.key &&
    view.screenPx === screenPx &&
    view.fovDeg === fovDeg &&
    Math.abs(Math.log(gapRatio(distance - body.radius, view.distance - view.radius))) < Math.log(LIMB_HYSTERESIS)
  )
    return
  view = { key: body.key, distance, radius: body.radius, screenPx, fovDeg }
  notify()
}

/** Ends the limb view, for when ship mode ends. */
export function clearLimbView(): void {
  if (view == null) return
  view = null
  notify()
}

/** The limb body's key in ship mode, else null. */
export function limbBody(): string | null {
  return view?.key ?? null
}

export function subscribeLimbBody(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** limbBody() when `among` accepts it, else null; re-renders when that changes. */
export function useLimbBodyAmong<K extends string>(among: (key: string) => key is K): K | null {
  return useSyncExternalStore(subscribeLimbBody, () => {
    const key = limbBody()
    return key != null && among(key) ? key : null
  })
}

/**
 * Whether body `key`'s sphere of `radius` and `segments` wants the limb
 * sphere: `key` is the limb body, the eye is outside the sphere (a shell seen
 * from inside, like a planet's haze from the collision stop, has no limb),
 * and its facets would pass LIMB_FACET_PX, or the eye is within `swapFloor`
 * of the sphere: a short screen's facets pass it only near the ground, or
 * never, and a sphere whose ground the ship stops on must swap well above
 * that (EarthRenderer).
 */
export function wantsLimbSphere(key: string | null, radius: number, segments: SphereSegments, swapFloor = 0): boolean {
  if (view == null || key !== view.key || view.distance <= radius) return false
  if (view.distance - radius < swapFloor) return true
  return limbFacetPx(segments, view.distance / radius, view.screenPx, view.fovDeg) > LIMB_FACET_PX
}

/** wantsLimbSphere, re-rendering only when it flips. */
export function useWantsLimbSphere(key: string | null, radius: number, segments: SphereSegments, swapFloor = 0): boolean {
  const [width, height] = segments
  return useSyncExternalStore(subscribeLimbBody, () => wantsLimbSphere(key, radius, [width, height], swapFloor))
}

// One LIMB_SEGMENTS sphere's topology per ship session (tides-01v.18): every
// limb sphere shares its index, uvs and normals, which three then uploads
// once (~5.7 MB), and owns only its positions (~1.6 MB), the unit sphere's,
// scaled: ~1 ms, where a build of its own takes ~5-13 ms. The positions stay
// in the body's own units, so no shader, shell radius or raycast changes.
interface LimbTopology {
  index: THREE.BufferAttribute
  normal: THREE.BufferAttribute
  uv: THREE.BufferAttribute
  unitPositions: ArrayLike<number>
}
let topology: LimbTopology | null = null

function limbTopology(): LimbTopology {
  if (topology) return topology
  const unit = new THREE.SphereGeometry(1, ...LIMB_SEGMENTS)
  topology = {
    index: unit.index!,
    normal: unit.getAttribute('normal') as THREE.BufferAttribute,
    uv: unit.getAttribute('uv') as THREE.BufferAttribute,
    unitPositions: unit.getAttribute('position').array,
  }
  return topology
}

function attachTopology(sphere: THREE.BufferGeometry): THREE.BufferGeometry {
  const { index, normal, uv } = limbTopology()
  sphere.setIndex(index)
  sphere.setAttribute('normal', normal)
  sphere.setAttribute('uv', uv)
  return sphere
}

function buildLimbSphere(radius: number): THREE.BufferGeometry {
  const { unitPositions } = limbTopology()
  const positions = new Float32Array(unitPositions.length)
  for (let i = 0; i < positions.length; i++) positions[i] = unitPositions[i] * radius
  const sphere = new THREE.BufferGeometry()
  sphere.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  sphere.userData.limbSphere = true
  return attachTopology(sphere)
}

/** Whether `geometry` is a limb sphere (limbSphere), not a body's own. */
export function isLimbSphere(geometry: THREE.BufferGeometry): boolean {
  return geometry.userData.limbSphere === true
}

// three frees every buffer a geometry holds when it is disposed, shared or
// not, but only for a geometry it has drawn (WebGLGeometries); a sphere still
// drawn would then keep pointing at the freed topology. So a sphere leaving
// while another shown one stays lets go of the topology first, and that one
// frees it later. With no other shown, the leaving one takes it along: no
// other has been drawn, and one drawn later uploads it afresh.
function disposeOwnPositions(sphere: THREE.BufferGeometry) {
  sphere.setIndex(null)
  sphere.deleteAttribute('normal')
  sphere.deleteAttribute('uv')
  sphere.dispose()
}

// The limb spheres by radius, kept so that the nearest body flipping between
// a planet and a close moon swaps a prop instead of rebuilding and uploading
// ~130k vertices. Meshes retain the ones they show (useLimbSphere), and only
// unretained ones beyond LIMB_CACHE_SIZE are disposed, oldest first, so a
// sphere on screen is never disposed. ShipController drops them all on exit.
const LIMB_CACHE_SIZE = 4
interface LimbEntry {
  sphere: THREE.BufferGeometry
  users: number
  /** Ever retained, so possibly drawn. */
  shown: boolean
}
const limbSpheres = new Map<number, LimbEntry>()

/**
 * The shared LIMB_SEGMENTS sphere of `radius`, built now if need be. Never
 * dispose it, and retain it (retainLimbSphere) while it may be drawn: an
 * unretained one may be trimmed, which leaves it without its topology.
 */
export function limbSphere(radius: number): THREE.BufferGeometry {
  const entry = limbSpheres.get(radius) ?? {
    sphere: buildLimbSphere(radius),
    users: 0,
    shown: false,
  }
  // Re-inserted, so the map runs from least to most recently used.
  limbSpheres.delete(radius)
  limbSpheres.set(radius, entry)
  return entry.sphere
}

/** The limb sphere of `radius` if it is built, else null; builds nothing. */
export function builtLimbSphere(radius: number): THREE.BufferGeometry | null {
  return limbSpheres.get(radius)?.sphere ?? null
}

/**
 * Whether a mesh holds the limb sphere of `radius` (retainLimbSphere): from
 * the commit after it first shows until the one after it goes, so a frame
 * either side may draw the mesh's own sphere instead.
 */
export function limbSphereInUse(radius: number): boolean {
  return (limbSpheres.get(radius)?.users ?? 0) > 0
}

// Building a limb sphere takes ~5-15 ms plus the garbage it leaves, and the
// ~7 MB upload follows on its first draw: together too long for one frame
// that also draws (Earth's three shells cost ~30-60 ms in one frame).
// Requests build one sphere per idle callback with room for it, off the frame
// and at most one per frame, and tell the store's listeners when each is
// ready, so each upload lands in a frame of its own. A build doesn't split,
// so a short idle period waits for a longer one; the timeout keeps a busy
// page (or a 120 Hz one, whose idle periods are all short) from starving it.
const BUILD_BUDGET_MS = 8
const BUILD_TIMEOUT_MS = 500
// Radii to build, with how many hooks still want each.
const buildQueue = new Map<number, number>()
let buildHandle: (() => void) | null = null

function whenIdle(callback: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    let handle = 0
    const wait = () => {
      handle = requestIdleCallback(
        (deadline) => (deadline.didTimeout || deadline.timeRemaining() >= BUILD_BUDGET_MS ? callback() : wait()),
        { timeout: BUILD_TIMEOUT_MS }
      )
    }
    wait()
    return () => cancelIdleCallback(handle)
  }
  const handle = setTimeout(callback, 0)
  return () => clearTimeout(handle)
}

function afterNextFrame(callback: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(callback)
    return () => cancelAnimationFrame(handle)
  }
  const handle = setTimeout(callback, 0)
  return () => clearTimeout(handle)
}

function scheduleBuild() {
  if (buildHandle || buildQueue.size === 0) return
  buildHandle = whenIdle(() => {
    const [radius] = buildQueue.keys()
    if (radius === undefined) {
      buildHandle = null
      return
    }
    buildQueue.delete(radius)
    // Trimmed only on release: the new sphere is unretained until its
    // hook re-renders and retains it.
    if (!limbSpheres.has(radius)) {
      limbSphere(radius)
      notify()
    }
    buildHandle = afterNextFrame(() => {
      buildHandle = null
      scheduleBuild()
    })
  })
}

/**
 * Builds the limb sphere of `radius` in an idle callback, unless built. The
 * returned cancel drops the request, and the build too once no request
 * wants it, so a quick flyby doesn't leave builds nobody shows.
 */
export function requestLimbSphere(radius: number): () => void {
  if (limbSpheres.has(radius)) return () => {}
  buildQueue.set(radius, (buildQueue.get(radius) ?? 0) + 1)
  scheduleBuild()
  let cancelled = false
  return () => {
    const count = buildQueue.get(radius)
    if (cancelled || count == null) return
    cancelled = true
    if (count > 1) buildQueue.set(radius, count - 1)
    else buildQueue.delete(radius)
  }
}

/** Marks `sphere` (from limbSphere) as on screen until the returned release. */
export function retainLimbSphere(radius: number, sphere: THREE.BufferGeometry): () => void {
  const found = limbSpheres.get(radius)
  // One already disposed comes back with the topology it let go of.
  const retained = found?.sphere === sphere ? found : { sphere: attachTopology(sphere), users: 0, shown: false }
  // Re-inserted as most recently used, as limbSphere does.
  limbSpheres.delete(radius)
  limbSpheres.set(radius, retained)
  retained.users++
  retained.shown = true
  return () => {
    retained.users--
    trimLimbSpheres()
  }
}

function trimLimbSpheres() {
  for (const [radius, entry] of limbSpheres) {
    if (limbSpheres.size <= LIMB_CACHE_SIZE) return
    if (entry.users > 0) continue
    const othersShown = [...limbSpheres.values()].some((other) => other !== entry && other.shown)
    if (othersShown) disposeOwnPositions(entry.sphere)
    else entry.sphere.dispose()
    limbSpheres.delete(radius)
  }
}

/**
 * Disposes every limb sphere and their topology, and drops queued builds,
 * for when ship mode ends. Each takes the topology along, so whichever the
 * renderer drew frees it.
 */
export function disposeLimbSpheres(): void {
  buildHandle?.()
  buildHandle = null
  buildQueue.clear()
  limbSpheres.forEach(({ sphere }) => sphere.dispose())
  limbSpheres.clear()
  topology = null
}

/**
 * The limb sphere of `radius` while `wanted`, once built off the frame
 * (requestLimbSphere) and retained while shown; else null, so callers keep
 * their own sphere until it is ready.
 */
export function useLimbSphere(radius: number, wanted: boolean): THREE.BufferGeometry | null {
  const sphere = useSyncExternalStore(subscribeLimbBody, () => (wanted ? builtLimbSphere(radius) : null))
  useEffect(() => (wanted && !sphere ? requestLimbSphere(radius) : undefined), [radius, sphere, wanted])
  useEffect(() => (sphere ? retainLimbSphere(radius, sphere) : undefined), [radius, sphere])
  return sphere
}

/**
 * Body `key`'s sphere of `radius`: its own `base` segments, or the shared
 * limb sphere while it wants one (wantsLimbSphere, with `swapFloor`) and
 * that is built.
 */
export function useBodySphere(
  key: string,
  radius: number,
  [width, height]: SphereSegments,
  swapFloor = 0
): THREE.BufferGeometry {
  const base = useMemo(() => new THREE.SphereGeometry(radius, width, height), [radius, width, height])
  useEffect(() => () => base.dispose(), [base])
  return useLimbSphere(radius, useWantsLimbSphere(key, radius, [width, height], swapFloor)) ?? base
}
