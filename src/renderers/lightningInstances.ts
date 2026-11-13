// The lightning's instanced quads (tides-ufyr.13): a fixed ring of flash
// slots, one draw for all of them. The CPU writes a slot when a flash
// starts (its direction and flicker seed, its wall-clock start, duration,
// brightness and glow radius) and the vertex shader plays it out
// (shaders/lightning/vertex.glsl), so a frame uploads only the slots it
// wrote: one or two ranges (three r180 clears them after each upload). A
// full ring drops new flashes.
import * as THREE from 'three'
import { FLASH_LIFETIME_S } from '../lightning'

/** An unused slot's start: long ago, so the shader skips it. */
export const DEAD_START_S = -1e9
/**
 * Starts are stored from a base this close behind now, so float32 keeps
 * them to well under a millisecond; past it the ring is rewritten from a
 * new base (once in ten minutes).
 */
export const REBASE_S = 600
/** Update ranges an attribute may queue before it uploads whole instead. */
export const MAX_RANGES = 8

export interface LightningInstances {
  readonly capacity: number
  readonly geometry: THREE.InstancedBufferGeometry
  /** Each slot's xyz: unit direction (Earth frame); w: flicker seed. */
  readonly dir: THREE.InstancedBufferAttribute
  /** Each slot's x: start (s, from the base); y: duration (s); z: brightness; w: glow radius (km). */
  readonly flash: THREE.InstancedBufferAttribute
  /** Begins a frame at wall time nowS; returns the shader's uTime. */
  begin(nowS: number): number
  /** Starts a flash now in the next slot; false when that slot is still lit. */
  write(x: number, y: number, z: number, seed: number, durS: number, brightness: number, radiusKm: number): boolean
  /** Marks what this frame wrote for upload. */
  flush(): void
  dispose(): void
}

export function createLightningInstances(capacity: number): LightningInstances {
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3))
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  const dirArray = new Float32Array(capacity * 4)
  const flashArray = new Float32Array(capacity * 4)
  for (let i = 0; i < capacity; i++) flashArray[i * 4] = DEAD_START_S
  const dir = new THREE.InstancedBufferAttribute(dirArray, 4)
  const flash = new THREE.InstancedBufferAttribute(flashArray, 4)
  dir.setUsage(THREE.DynamicDrawUsage)
  flash.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('aDir', dir)
  geometry.setAttribute('aFlash', flash)
  geometry.instanceCount = capacity

  /** Absolute wall starts, s (-Infinity unused). */
  const starts = new Float64Array(capacity).fill(-Infinity)
  let head = 0
  let base = 0
  let now = 0
  let dirtyStart = 0
  let dirtyCount = 0
  let rebased = false

  const alive = (slot: number) => starts[slot] + FLASH_LIFETIME_S > now

  // Attributes due a whole-array upload (no ranges) at their next upload.
  let dirWhole = false
  let flashWhole = false
  dir.onUpload(() => {
    dirWhole = false
  })
  flash.onUpload(() => {
    flashWhole = false
  })

  // Queues this frame's slots; a View that skips draws (a side panel's
  // rate) piles ranges up, so past a few the whole array goes instead.
  function queue(attribute: THREE.InstancedBufferAttribute, whole: boolean): boolean {
    attribute.needsUpdate = true
    if (whole || attribute.updateRanges.length >= MAX_RANGES) {
      attribute.clearUpdateRanges()
      return true
    }
    const first = Math.min(dirtyCount, capacity - dirtyStart)
    attribute.addUpdateRange(dirtyStart * 4, first * 4)
    if (dirtyCount > first) attribute.addUpdateRange(0, (dirtyCount - first) * 4)
    return false
  }

  return {
    capacity,
    geometry,
    dir,
    flash,
    begin(nowS) {
      now = nowS
      if (nowS - base > REBASE_S || nowS < base) {
        base = nowS
        for (let i = 0; i < capacity; i++) flashArray[i * 4] = alive(i) ? starts[i] - base : DEAD_START_S
        rebased = true
      }
      return now - base
    },
    write(x, y, z, seed, durS, brightness, radiusKm) {
      const slot = head
      if (alive(slot)) return false
      const o = slot * 4
      dirArray[o] = x
      dirArray[o + 1] = y
      dirArray[o + 2] = z
      dirArray[o + 3] = seed
      flashArray[o] = now - base
      flashArray[o + 1] = durS
      flashArray[o + 2] = brightness
      flashArray[o + 3] = radiusKm
      starts[slot] = now
      if (dirtyCount === 0) dirtyStart = slot
      dirtyCount++
      head = (slot + 1) % capacity
      return true
    },
    flush() {
      // A rebase moved every start.
      if (rebased || dirtyCount > 0) flashWhole = queue(flash, flashWhole || rebased)
      if (dirtyCount > 0) dirWhole = queue(dir, dirWhole)
      dirtyCount = 0
      rebased = false
    },
    dispose() {
      geometry.dispose()
    },
  }
}
