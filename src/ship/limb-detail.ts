// The nearest body's limb in flight (tides-01v.5). A body's sphere is a
// polyhedron inscribed in it, so its silhouette dips between vertices: from
// the ship's collision stop the limb is only ~0.2 R away, and a 128-segment
// sphere's facets show as ~3 px notches on a 1600 px tall screen (a 64×32
// moon's as ~16 px). Only the nearest body is ever that close, so only it
// trades up to LIMB_SEGMENTS; every other body keeps its own, cheaper sphere.

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import * as THREE from 'three'

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

// The ship's nearest body, set by ShipController while ship mode runs and
// null otherwise. Ship mode and the main view never mount together, so
// outside ship mode no body changes.
let nearest: string | null = null
const listeners = new Set<() => void>()

/** ShipController's per-frame report; listeners hear only real changes. */
export function setLimbBody(key: string | null): void {
  if (key === nearest) return
  nearest = key
  listeners.forEach((listener) => listener())
}

/** The nearest body's key in ship mode, else null. */
export function limbBody(): string | null {
  return nearest
}

export function subscribeLimbBody(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** limbBody() when `among` accepts it, else null; re-renders when that changes. */
export function useLimbBodyAmong(among: (key: string) => boolean): string | null {
  return useSyncExternalStore(subscribeLimbBody, () => (nearest != null && among(nearest) ? nearest : null))
}

/** True while `key` is the ship's nearest body; re-renders only when that flips. */
export function useIsLimbBody(key: string): boolean {
  return useSyncExternalStore(subscribeLimbBody, () => nearest === key)
}

// The limb spheres by radius, kept so that the nearest body flipping between
// a planet and a close moon swaps a prop instead of rebuilding and uploading
// ~130k vertices. Meshes retain the ones they show (useLimbSphere), and only
// unretained ones beyond LIMB_CACHE_SIZE are disposed, oldest first, so a
// sphere on screen is never disposed. ShipController drops them all on exit.
const LIMB_CACHE_SIZE = 4
const limbSpheres = new Map<number, { sphere: THREE.SphereGeometry; users: number }>()

/** The shared LIMB_SEGMENTS sphere of `radius`, built on first use. Never dispose it. */
export function limbSphere(radius: number): THREE.SphereGeometry {
  const entry = limbSpheres.get(radius) ?? {
    sphere: new THREE.SphereGeometry(radius, ...LIMB_SEGMENTS),
    users: 0,
  }
  // Re-inserted, so the map runs from least to most recently used.
  limbSpheres.delete(radius)
  limbSpheres.set(radius, entry)
  return entry.sphere
}

/** Marks `sphere` (from limbSphere) as on screen until the returned release. */
export function retainLimbSphere(radius: number, sphere: THREE.SphereGeometry): () => void {
  let entry = limbSpheres.get(radius)
  if (entry?.sphere !== sphere) {
    entry = { sphere, users: 0 }
    limbSpheres.set(radius, entry)
  }
  const retained = entry
  retained.users++
  return () => {
    retained.users--
    trimLimbSpheres()
  }
}

function trimLimbSpheres() {
  for (const [radius, entry] of limbSpheres) {
    if (limbSpheres.size <= LIMB_CACHE_SIZE) return
    if (entry.users > 0) continue
    entry.sphere.dispose()
    limbSpheres.delete(radius)
  }
}

/** Disposes every limb sphere, for when ship mode ends. */
export function disposeLimbSpheres(): void {
  limbSpheres.forEach(({ sphere }) => sphere.dispose())
  limbSpheres.clear()
}

/** The limb sphere of `radius` while `active`, retained while shown; else null. */
export function useLimbSphere(radius: number, active: boolean): THREE.SphereGeometry | null {
  const sphere = useMemo(() => (active ? limbSphere(radius) : null), [active, radius])
  useEffect(() => (sphere ? retainLimbSphere(radius, sphere) : undefined), [radius, sphere])
  return sphere
}

/**
 * Body `key`'s sphere of `radius`: its own `base` segments, or the shared
 * limb sphere while the ship is nearest it.
 */
export function useBodySphere(
  key: string,
  radius: number,
  [width, height]: SphereSegments
): THREE.SphereGeometry {
  const base = useMemo(() => new THREE.SphereGeometry(radius, width, height), [radius, width, height])
  useEffect(() => () => base.dispose(), [base])
  return useLimbSphere(radius, useIsLimbBody(key)) ?? base
}
