// What each View's scene draws into its glow (tides-64u; ./glow.ts). A
// source registers an object whose subtree is on GLOW_LAYER: an emissive
// stand-in, a black occluder, or a copy of the real thing (the aurora's).
// Keyed by the View's scene (drei's portal scene), which GlowPass in the same
// View reads, so the panels' scenes never mix.
import { useEffect, type RefObject } from 'react'
import { useThree } from '@react-three/fiber'
import type * as THREE from 'three'
import { qualityTier } from '../../quality'
import { resolveGlow } from './glow'

/**
 * Draw order within the glow target: occluders and opaque stand-ins write
 * depth first, then what adds over them (the aurora) tests against it.
 */
export const GLOW_ORDER = { opaque: 0, additive: 1 } as const

export interface GlowSource {
  object: THREE.Object3D
  order: number
  /** False for a black occluder: it only hides glow, so the pass's reach
   * (glow-pass.ts) leaves it out. */
  emits: boolean
}

const byScene = new WeakMap<THREE.Object3D, GlowSource[]>()

let on: boolean | null = null

/** Whether this page draws glow (./glow.ts resolveGlow), read once. */
export function glowOn(): boolean {
  if (on == null) on = typeof window === 'undefined' ? false : resolveGlow(window.location.search, qualityTier())
  return on
}

/** Registers `object` in `scene`'s glow; returns the unregister. */
export function addGlowSource(scene: THREE.Object3D, object: THREE.Object3D, order: number, emits = true): () => void {
  let list = byScene.get(scene)
  if (!list) {
    list = []
    byScene.set(scene, list)
  }
  const source = { object, order, emits }
  // Kept sorted by order, stable for equal orders, so the pass never sorts.
  const at = list.findIndex((s) => s.order > order)
  if (at < 0) list.push(source)
  else list.splice(at, 0, source)
  return () => {
    const current = byScene.get(scene)
    const i = current ? current.indexOf(source) : -1
    if (current && i >= 0) current.splice(i, 1)
  }
}

const none: readonly GlowSource[] = []

/** `scene`'s glow sources in draw order. */
export function glowSourcesOf(scene: THREE.Object3D): readonly GlowSource[] {
  return byScene.get(scene) ?? none
}

/** Registers the ref'd object in this View's glow while mounted (and glow is on). */
export function useGlowSource(ref: RefObject<THREE.Object3D | null>, order: number = GLOW_ORDER.opaque, emits = true): void {
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    const object = ref.current
    if (!object || !glowOn()) return
    return addGlowSource(scene, object, order, emits)
  }, [scene, ref, order, emits])
}

/** False when the object or any ancestor is hidden (gl.render of a subtree checks only its root). */
export function shownInWorld(object: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = object; o; o = o.parent) if (!o.visible) return false
  return true
}
