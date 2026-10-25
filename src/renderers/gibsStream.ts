// Streams a square of GIBS tiles around the ship's sub-point into one render
// target (tides-01v.7; tiles in ../gibs-patch.ts), for the ground patches
// that read it: the day imagery (./gibsPatch.ts) and the night lights
// (./gibsNightPatch.ts, tides-tvr.2). Each tile is drawn into its slot (row
// and column mod the side) through the patch's own pass, so moving the patch
// a tile refills one row or column and every texture neighbour is a ground
// neighbour except across the patch's own edge, which the patches fade out.
// An R8 mask, a texel a slot, holds each tile's fade-in: a tile still
// loading, or failed (offline), leaves the global map, and the patches fade
// its shown neighbours out toward it.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, type RefObject } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import { flightTextureCap } from '../quality'
import {
  GIBS_PATCH_RANGE,
  GIBS_PATCH_RELEASE,
  GIBS_TILE_PX,
  gibsPatchSide,
  gibsPatchTiles,
  gibsTileAt,
  nextGibsPatchOrigin,
  type GibsPatchOrigin,
  type GibsPatchTile,
  type GibsTile,
  type GibsTileStore,
} from '../gibs-patch'
import type { MaterialPatch } from './eclipseShadow'

/** Fetches in flight at once, and tiles uploaded a frame (each regenerates
 * the texture's mips, and a 512 px upload is ~1 MB). */
export const MAX_IN_FLIGHT = 6
export const UPLOADS_PER_FRAME = 2
const FADE_IN_MS = 400
/** A failed tile is tried again this much later, if still wanted. */
const RETRY_MS = 30_000
/** Of a tile's width: the patch's faded rim, and the fade toward an edge
 * shared with a tile that isn't shown. That one's slot holds nothing, or
 * another tile, so the fade must outrun the blurred sample's reach into it
 * (up to the day map's texel, 8 patch texels on desktops, ~40 on phones). */
export const EDGE_TILES = 0.5
export const SEAM_TILES = 0.25

/** Draws a tile into the slot the target's viewport frames. */
export interface GibsStreamPass {
  scene: THREE.Scene
  camera: THREE.Camera
  tile: THREE.Texture
  /** Everything, where freeing the tile's 1 MB copy keeps the program (and
   * whatever else it holds) for the next approach. */
  dispose(): void
}

export interface GibsStreamOptions {
  /** Tiles along the side (gibsPatchSide). */
  side: number
  store: GibsTileStore
  tileUrl: (row: number, col: number) => string
  /** For the offline warning: "<label> tile r/c failed; keeping <fallback>
   * there". */
  label: string
  fallback: string
  /** The target, not yet initialised. */
  createTarget(gl: THREE.WebGLRenderer): THREE.WebGLRenderTarget
  createPass(): GibsStreamPass
  /** Whether to stream at all for the ship over `subPoint` (a unit vector
   * in the ground's frame), once it is in range; `active`: streaming now.
   * When it says no the stream lets everything go, as out of range. */
  wanted?(subPoint: THREE.Vector3, ground: THREE.Object3D, active: boolean): boolean
}

export interface GibsStream {
  /** For the patches' own uniforms: the target's texture (null while
   * nothing is drawn), the fade mask, the north-west tile (column, row) and
   * 1 while the texture is live. */
  uniforms: {
    texture: THREE.IUniform<THREE.Texture | null>
    mask: THREE.IUniform<THREE.DataTexture>
    origin: THREE.IUniform<THREE.Vector2>
    active: THREE.IUniform<number>
  }
  /** `ground`: the ground mesh, whose local sphere has `radius`. */
  update(gl: THREE.WebGLRenderer, camera: THREE.Camera, ground: THREE.Object3D, radius: number, now: number): void
  /** Frees the texture; the stream fills again if update finds the ship near. */
  release(): void
  /** Frees everything, the pass and the mask too (three uploads the mask
   * again if the stream is used after). */
  dispose(): void
}

type Slot =
  | { state: 'empty' }
  | { state: 'loading'; tile: GibsPatchTile }
  | { state: 'failed'; tile: GibsPatchTile; retryAt: number }
  | { state: 'ready'; tile: GibsPatchTile; bitmap: ImageBitmap }
  | { state: 'shown'; tile: GibsPatchTile; since: number }

export function createGibsStream({
  side,
  store,
  tileUrl,
  label,
  fallback,
  createTarget,
  createPass,
  wanted,
}: GibsStreamOptions): GibsStream {
  const maskData = new Uint8Array(side * side)
  const mask = new THREE.DataTexture(maskData, side, side, THREE.RedFormat, THREE.UnsignedByteType)
  mask.magFilter = mask.minFilter = THREE.NearestFilter
  mask.unpackAlignment = 1
  mask.needsUpdate = true
  const uniforms: GibsStream['uniforms'] = {
    texture: { value: null },
    mask: { value: mask },
    origin: { value: new THREE.Vector2() },
    active: { value: 0 },
  }
  // In range (allocated on the first tile, so offline holds no texture).
  let active = false
  let target: THREE.WebGLRenderTarget | null = null
  let pass: GibsStreamPass | null = null
  let origin: GibsPatchOrigin | null = null
  let centre: GibsTile | null = null
  // The patch's tiles, nearest the ship first, for the current origin and centre.
  let tiles: GibsPatchTile[] = []
  let slots: Slot[] = Array.from({ length: side * side }, () => ({ state: 'empty' }))
  let inFlight = 0
  // Bumped by release, so loads it orphaned drop their bitmaps.
  let generation = 0
  // Offline, every tile fails each retry: say so once, until one loads.
  let warned = false

  const local = new THREE.Vector3()
  const at = new THREE.Vector2()

  function initTarget(gl: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
    const created = createTarget(gl)
    gl.initRenderTarget(created)
    uniforms.texture.value = created.texture
    uniforms.active.value = 1
    return created
  }

  function release() {
    generation++
    for (const slot of slots) if (slot.state === 'ready') slot.bitmap.close()
    slots = slots.map(() => ({ state: 'empty' }))
    maskData.fill(0)
    mask.needsUpdate = true
    target?.dispose()
    target = null
    pass?.tile.dispose()
    active = false
    origin = null
    centre = null
    tiles = []
    inFlight = 0
    uniforms.texture.value = null
    uniforms.active.value = 0
  }

  function load(index: number, tile: GibsPatchTile, now: number) {
    const loadedIn = generation
    slots[index] = { state: 'loading', tile }
    inFlight++
    store
      .get(tile.url)
      .then((blob) => createImageBitmap(blob))
      .then(
        (bitmap) => {
          if (loadedIn !== generation) return bitmap.close()
          inFlight--
          warned = false
          const slot = slots[index]
          if (slot.state === 'loading' && slot.tile === tile) slots[index] = { state: 'ready', tile, bitmap }
          else bitmap.close()
        },
        (err: unknown) => {
          if (loadedIn !== generation) return
          inFlight--
          if (!warned) console.warn(`${label} tile ${tile.row}/${tile.col} failed; keeping ${fallback} there`, err)
          warned = true
          const slot = slots[index]
          if (slot.state === 'loading' && slot.tile === tile) {
            slots[index] = { state: 'failed', tile, retryAt: now + RETRY_MS }
          }
        }
      )
  }

  function update(gl: THREE.WebGLRenderer, camera: THREE.Camera, ground: THREE.Object3D, radius: number, now: number) {
    ground.worldToLocal(local.copy(camera.position))
    const gap = local.length() / radius - 1
    if (active ? gap > GIBS_PATCH_RELEASE : gap > GIBS_PATCH_RANGE) {
      if (active) release()
      return
    }
    local.normalize()
    if (wanted && !wanted(local, ground, active)) {
      if (active) release()
      return
    }
    active = true

    // The sub-point, as the day map's coordinate (SphereGeometry's uv).
    at.set(Math.atan2(local.z, -local.x) / (2 * Math.PI), 0.5 + Math.asin(local.y) / Math.PI)
    const under = gibsTileAt(at.x, at.y)
    const next = nextGibsPatchOrigin(under, side, origin)
    let maskChanged = false
    if (next !== origin || under.row !== centre?.row || under.col !== centre.col) {
      centre = under
      tiles = gibsPatchTiles(next, side, under, tileUrl)
    }
    if (next !== origin) {
      origin = next
      uniforms.origin.value.set(next.col, next.row)
      for (const tile of tiles) {
        const slot = slots[tile.slot]
        if (slot.state !== 'empty' && slot.tile.url === tile.url) continue
        if (slot.state === 'ready') slot.bitmap.close()
        slots[tile.slot] = { state: 'empty' }
        maskData[tile.slot] = 0
        maskChanged = true
      }
    }

    // Fetch the nearest missing tiles first.
    for (const tile of tiles) {
      if (inFlight >= MAX_IN_FLIGHT) break
      const slot = slots[tile.slot]
      if (slot.state === 'empty' || (slot.state === 'failed' && now >= slot.retryAt)) load(tile.slot, tile, now)
    }

    // Drawn into the slot, without clearing the rest. The mips are rebuilt
    // once, after the frame's last.
    _ready.length = 0
    for (let i = 0; i < slots.length && _ready.length < UPLOADS_PER_FRAME; i++) {
      if (slots[i].state === 'ready') _ready.push(i)
    }
    if (_ready.length > 0) {
      const into = (target ??= initTarget(gl))
      const drawing = (pass ??= createPass())
      const previous = gl.getRenderTarget()
      const autoClear = gl.autoClear
      gl.autoClear = false
      try {
        _ready.forEach((i, k) => {
          const slot = slots[i]
          if (slot.state !== 'ready') return
          into.texture.generateMipmaps = k === _ready.length - 1
          into.viewport.set(
            (slot.tile.col % side) * GIBS_TILE_PX,
            (slot.tile.row % side) * GIBS_TILE_PX,
            GIBS_TILE_PX,
            GIBS_TILE_PX
          )
          // The scissor too, so tiled GPUs load and store only the slot.
          into.scissor.copy(into.viewport)
          into.scissorTest = true
          drawing.tile.image = slot.bitmap
          drawing.tile.needsUpdate = true
          gl.setRenderTarget(into)
          gl.render(drawing.scene, drawing.camera)
          into.texture.generateMipmaps = true
          slot.bitmap.close()
          slots[i] = { state: 'shown', tile: slot.tile, since: now }
        })
      } finally {
        gl.setRenderTarget(previous)
        gl.autoClear = autoClear
      }
    }

    slots.forEach((slot, i) => {
      if (slot.state !== 'shown') return
      const fade = Math.round(255 * Math.min(1, (now - slot.since) / FADE_IN_MS))
      if (maskData[i] !== fade) {
        maskData[i] = fade
        maskChanged = true
      }
    })
    if (maskChanged) mask.needsUpdate = true
  }

  return {
    uniforms,
    update,
    release,
    dispose() {
      release()
      pass?.dispose()
      pass = null
      mask.dispose()
    },
  }
}

const _ready: number[] = []

/** A streamed patch for the ground's material, as useStreamedPatch takes it. */
export interface StreamedPatch {
  /** For composePatches; empty where the device takes no patch. */
  material: MaterialPatch
  /** `ground`: the ground mesh, whose local sphere has `radius`. */
  update(gl: THREE.WebGLRenderer, camera: THREE.Camera, ground: THREE.Object3D, radius: number, now: number): void
  /** Frees everything; the patch fills again if update finds the ship near. */
  release(): void
}

/**
 * The patch `create` makes for the ground mesh in `ground` (local sphere of
 * `radius`): in ship mode, on devices that take one, filled as the ship
 * nears Earth and freed when it leaves or the flight ends. `create` gets the
 * side (gibsPatchSide), 0 for none.
 */
export function useStreamedPatch(
  create: (side: number) => StreamedPatch,
  ground: RefObject<THREE.Object3D | null>,
  radius: number
): MaterialPatch {
  const shipMode = useStore((s) => s.shipMode)
  const gl = useThree((s) => s.gl)
  const side = useMemo(
    () => (shipMode ? gibsPatchSide(flightTextureCap(gl.capabilities.maxTextureSize)) : 0),
    [shipMode, gl]
  )
  const patch = useMemo(() => create(side), [create, side])
  useEffect(() => () => patch.release(), [patch])
  // A restored context has lost the texture (as for the cloud blend).
  useEffect(() => {
    const canvas = gl.domElement
    const restart = () => patch.release()
    canvas.addEventListener('webglcontextrestored', restart)
    return () => canvas.removeEventListener('webglcontextrestored', restart)
  }, [gl, patch])
  useFrame(({ camera, gl }) => {
    if (ground.current) patch.update(gl, camera, ground.current, radius, performance.now())
  })
  return patch.material
}
