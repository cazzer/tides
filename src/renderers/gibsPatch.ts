// The GIBS imagery patch under the ship (tides-01v.7; tiles in ../gibs-patch.ts),
// on the ground's Phong material through composePatches. Tiles are uploaded
// straight into one sRGB render-target texture, each into its slot (row and
// column mod the side), so moving the patch a tile refills one row or column
// and every texture neighbour is a ground neighbour except across the patch's
// own edge, which is faded out. An R8 mask, a texel a slot, holds each tile's
// fade-in: a tile still loading, or failed (offline), leaves the global map,
// and its shown neighbours fade out toward it.
//
// No GIBS layer matches the day map's grading (its ocean is a lit teal, Blue
// Marble's near black), so the patch adds only what the day map lacks: its
// difference from itself blurred to the day map's texel, in sRGB. The large
// scale stays the day map's, so nothing shows a seam, and the patch fades out
// by itself wherever the day map already resolves the ground. Night lights,
// the specular mask and the clouds are untouched.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useSyncExternalStore, type RefObject } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import { flightTextureCap } from '../quality'
import {
  createGibsTileStore,
  GIBS_COLS,
  GIBS_GROUND_WIDTH,
  GIBS_PATCH_RANGE,
  GIBS_PATCH_RELEASE,
  GIBS_ROWS,
  GIBS_TILE_PX,
  gibsPatchSide,
  gibsPatchTiles,
  gibsTileAt,
  nextGibsPatchOrigin,
  type GibsPatchOrigin,
  type GibsPatchTile,
  type GibsTile,
} from '../gibs-patch'
import { POLE_SMOOTH_FROM, POLE_SMOOTH_TO } from './poleSmoothing'
import type { MaterialPatch } from './eclipseShadow'

/** Fetches in flight at once, and tiles uploaded a frame (each regenerates
 * the texture's mips, and a 512 px upload is ~1 MB). */
const MAX_IN_FLIGHT = 6
const UPLOADS_PER_FRAME = 2
const FADE_IN_MS = 400
/** A failed tile is tried again this much later, if still wanted. */
const RETRY_MS = 30_000
/** Of a tile's width: the patch's faded rim, and the fade toward an edge
 * shared with a tile that isn't shown. That one's slot holds nothing, or
 * another tile, so the fade must outrun the blurred sample's reach into it
 * (up to the day map's texel, 8 patch texels on desktops, ~40 on phones). */
const EDGE_TILES = 0.5
const SEAM_TILES = 0.25

// Offline, every tile fails each retry: say so once, until one loads.
let warned = false

// Shared by every flight: a few hundred tiles is ~10-20 MB of JPEG.
const store = createGibsTileStore(async (url) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GIBS tile ${url}: HTTP ${response.status}`)
  return response.blob()
}, 400)

/** Network requests for GIBS ground tiles this page has made. */
export function gibsTileRequests(): number {
  return store.requests
}

// Whether any patch imagery is on screen, for its credit.
let shown = false
const listeners = new Set<() => void>()
function setShown(value: boolean) {
  if (value === shown) return
  shown = value
  listeners.forEach((listener) => listener())
}
export function useGibsPatchShown(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => shown
  )
}

const f = (x: number) => x.toFixed(6)

const fragmentHead = (side: number) => /* glsl */ `
uniform sampler2D uGibsPatch;
uniform sampler2D uGibsMask;
// The patch's north-west tile: column, row.
uniform vec2 uGibsOrigin;
uniform float uGibsActive;
#define GIBS_SIDE ${f(side)}

// A slot's fade-in, for unwrapped tile coordinates.
float gibsMask(ivec2 tile) {
  return texelFetch(uGibsMask, tile & ${side - 1}, 0).r;
}
`

// After the albedo (and the poles' smoothing of it), before anything reads
// it. vMapUv is the day map's own coordinate, so the patch registers with it.
const ALBEDO_BODY = /* glsl */ `
float gibsCover = 0.0;
#if defined(USE_MAP) && defined(USE_SPECULARMAP)
if (uGibsActive > 0.5) {
  // Tiles from the patch's north-west corner; derivatives before branching.
  vec2 gibsAt = vec2(
    fract(vMapUv.x - uGibsOrigin.x / ${f(GIBS_COLS)}) * ${f(GIBS_COLS)},
    (1.0 - vMapUv.y) * ${f(GIBS_ROWS)} - uGibsOrigin.y);
  vec2 gibsDx = dFdx(gibsAt);
  vec2 gibsDy = dFdy(gibsAt);
  gibsDx.x -= ${f(GIBS_COLS)} * floor(gibsDx.x / ${f(GIBS_COLS)} + 0.5);
  gibsDy.x -= ${f(GIBS_COLS)} * floor(gibsDy.x / ${f(GIBS_COLS)} + 0.5);
  // log2 of the day map's texel in patch texels, and of the pixel's.
  float gibsMapLod = log2(${f(GIBS_GROUND_WIDTH)} / float(textureSize(map, 0).x));
  float gibsPixelLod = log2(max(length(gibsDx), length(gibsDy)) * ${f(GIBS_TILE_PX)});
  float gibsEdge = min(min(gibsAt.x, GIBS_SIDE - gibsAt.x), min(gibsAt.y, GIBS_SIDE - gibsAt.y));
  if (gibsEdge > 0.0 && gibsPixelLod < gibsMapLod) {
    // Unwrapped tile coordinates: the textures repeat, so mod GIBS_SIDE is
    // the slot. Toward a tile's edge its fade-in is multiplied in turn by the
    // neighbours' there, the same product from either side of the edge.
    vec2 q = uGibsOrigin + gibsAt;
    ivec2 cell = ivec2(floor(q));
    vec2 e = fract(q) - 0.5;
    ivec2 toward = ivec2(sign(e));
    vec2 ramp = smoothstep(${f(0.5 - SEAM_TILES)}, 0.5, abs(e));
    float mask = gibsMask(cell)
      * mix(1.0, gibsMask(cell + ivec2(toward.x, 0)), ramp.x)
      * mix(1.0, gibsMask(cell + ivec2(0, toward.y)), ramp.y)
      * mix(1.0, gibsMask(cell + toward), ramp.x * ramp.y);
    float lat = (vMapUv.y - 0.5) * 180.0;
    // Faded over the last mip before the day map resolves as much, so the
    // ground detail's octaves come back gradually (the cut-off is in uv, so
    // off the equator it falls inside the detail's range).
    gibsCover = mask * smoothstep(0.0, ${f(EDGE_TILES)}, gibsEdge)
      * (1.0 - smoothstep(${f(POLE_SMOOTH_FROM)}, ${f(POLE_SMOOTH_TO)}, abs(lat)))
      * (1.0 - smoothstep(gibsMapLod - 1.0, gibsMapLod, gibsPixelLod));
    if (gibsCover > 0.0) {
      vec2 st = q / GIBS_SIDE;
      vec2 gx = gibsDx / GIBS_SIDE;
      vec2 gy = gibsDy / GIBS_SIDE;
      // The patch as the day map shows it: each axis of the pixel's
      // footprint widened to at least the day map's texel.
      float mapTexel = exp2(gibsMapLod) / ${f(GIBS_TILE_PX)};
      vec2 cx = gx * max(1.0, mapTexel / max(length(gibsDx), 1e-9));
      vec2 cy = gy * max(1.0, mapTexel / max(length(gibsDy), 1e-9));
      vec3 fine = sRGBTransferOETF(textureGrad(uGibsPatch, st, gx, gy)).rgb;
      vec3 coarse = sRGBTransferOETF(textureGrad(uGibsPatch, st, cx, cy)).rgb;
      vec3 base = sRGBTransferOETF(vec4(diffuseColor.rgb, 1.0)).rgb;
      diffuseColor.rgb = sRGBTransferEOTF(vec4(clamp(base + gibsCover * (fine - coarse), 0.0, 1.0), 1.0)).rgb;
    }
  }
}
#endif
`

// Where the patch shows, the ground detail (./groundDetail.ts) drops the
// octaves its imagery resolves.
const DETAIL_BODY = /* glsl */ `
#if defined(USE_MAP) && defined(USE_SPECULARMAP)
groundDetailFine = gibsCover;
groundDetailFineTexel = groundDetailTexel * float(textureSize(map, 0).x) / ${f(GIBS_GROUND_WIDTH)};
#endif
`

// Before the chunk by default: the pole smoothing replaces map_fragment
// outright, and the ground detail's texel follows specularmap_fragment.
function inject(source: string, chunk: string, code: string, where: 'before' | 'after' = 'before'): string {
  const include = `#include <${chunk}>`
  if (!source.includes(include)) {
    throw new Error(`GIBS patch: shader has no ${include}`)
  }
  return source.replace(include, where === 'before' ? `${code}\n${include}` : `${include}\n${code}`)
}

type Slot =
  | { state: 'empty' }
  | { state: 'loading'; tile: GibsPatchTile }
  | { state: 'failed'; tile: GibsPatchTile; retryAt: number }
  | { state: 'ready'; tile: GibsPatchTile; bitmap: ImageBitmap }
  | { state: 'shown'; tile: GibsPatchTile; since: number }

export interface GibsPatch {
  /** For composePatches; empty where the device takes no patch. */
  material: MaterialPatch
  /** `ground`: the ground mesh, whose local sphere has `radius`. */
  update(gl: THREE.WebGLRenderer, camera: THREE.Camera, ground: THREE.Object3D, radius: number, now: number): void
  /** Frees the texture; the patch fills again if update finds the ship near. */
  release(): void
}

/** A patch `side` tiles square (gibsPatchSide); 0 for none. */
export function createGibsPatch(side: number): GibsPatch {
  if (side === 0) {
    return {
      material: { onBeforeCompile() {}, customProgramCacheKey: () => '' },
      update() {},
      release() {},
    }
  }
  const maskData = new Uint8Array(side * side)
  const mask = new THREE.DataTexture(maskData, side, side, THREE.RedFormat, THREE.UnsignedByteType)
  mask.magFilter = mask.minFilter = THREE.NearestFilter
  mask.unpackAlignment = 1
  mask.needsUpdate = true
  const uniforms = {
    uGibsPatch: { value: null as THREE.Texture | null },
    uGibsMask: { value: mask },
    uGibsOrigin: { value: new THREE.Vector2() },
    uGibsActive: { value: 0 },
  }
  // In range (allocated on the first tile, so offline holds no texture).
  let active = false
  let target: THREE.WebGLRenderTarget | null = null
  let origin: GibsPatchOrigin | null = null
  let centre: GibsTile | null = null
  // The patch's tiles, nearest the ship first, for the current origin and centre.
  let tiles: GibsPatchTile[] = []
  let slots: Slot[] = Array.from({ length: side * side }, () => ({ state: 'empty' }))
  let inFlight = 0
  // Bumped by release, so loads it orphaned drop their bitmaps.
  let generation = 0

  const local = new THREE.Vector3()
  const at = new THREE.Vector2()

  function createTarget(gl: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
    const created = new THREE.WebGLRenderTarget(side * GIBS_TILE_PX, side * GIBS_TILE_PX, {
      colorSpace: THREE.SRGBColorSpace,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      anisotropy: gl.capabilities.getMaxAnisotropy(),
      depthBuffer: false,
    })
    gl.initRenderTarget(created)
    uniforms.uGibsPatch.value = created.texture
    uniforms.uGibsActive.value = 1
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
    active = false
    origin = null
    centre = null
    tiles = []
    inFlight = 0
    uniforms.uGibsPatch.value = null
    uniforms.uGibsActive.value = 0
    setShown(false)
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
          if (!warned) console.warn(`GIBS tile ${tile.row}/${tile.col} failed; keeping the day map there`, err)
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
    active = true

    // The sub-point, as the day map's coordinate (SphereGeometry's uv).
    local.normalize()
    at.set(Math.atan2(local.z, -local.x) / (2 * Math.PI), 0.5 + Math.asin(local.y) / Math.PI)
    const under = gibsTileAt(at.x, at.y)
    const next = nextGibsPatchOrigin(under, side, origin)
    let maskChanged = false
    if (next !== origin || under.row !== centre?.row || under.col !== centre.col) {
      centre = under
      tiles = gibsPatchTiles(next, side, under)
    }
    if (next !== origin) {
      origin = next
      uniforms.uGibsOrigin.value.set(next.col, next.row)
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

    // Straight into the slot: three uploads a never-used texture's image with
    // texSubImage2D. The mips are rebuilt once, with the frame's last.
    _ready.length = 0
    for (let i = 0; i < slots.length && _ready.length < UPLOADS_PER_FRAME; i++) {
      if (slots[i].state === 'ready') _ready.push(i)
    }
    _ready.forEach((i, k) => {
      const slot = slots[i]
      if (slot.state !== 'ready') return
      target ??= createTarget(gl)
      target.texture.generateMipmaps = k === _ready.length - 1
      _offset.set((slot.tile.col % side) * GIBS_TILE_PX, (slot.tile.row % side) * GIBS_TILE_PX)
      gl.copyTextureToTexture(new THREE.Texture(slot.bitmap), target.texture, null, _offset)
      target.texture.generateMipmaps = true
      slot.bitmap.close()
      slots[i] = { state: 'shown', tile: slot.tile, since: now }
    })

    let shownAny = false
    slots.forEach((slot, i) => {
      if (slot.state !== 'shown') return
      shownAny = true
      const fade = Math.round(255 * Math.min(1, (now - slot.since) / FADE_IN_MS))
      if (maskData[i] !== fade) {
        maskData[i] = fade
        maskChanged = true
      }
    })
    if (maskChanged) mask.needsUpdate = true
    setShown(shownAny)
  }

  return {
    material: {
      onBeforeCompile(shader) {
        Object.assign(shader.uniforms, uniforms)
        shader.fragmentShader = inject(
          inject(inject(shader.fragmentShader, 'common', fragmentHead(side), 'after'), 'color_fragment', ALBEDO_BODY),
          'normal_fragment_begin',
          DETAIL_BODY
        )
      },
      customProgramCacheKey: () => `gibs-patch-${side}`,
    },
    update,
    release() {
      release()
      // three uploads it again if the patch is used after.
      mask.dispose()
    },
  }
}

const _offset = new THREE.Vector2()
const _ready: number[] = []

/**
 * The patch for the ground mesh in `ground` (local sphere of `radius`): in
 * ship mode, on devices that take one, filled as the ship nears Earth and
 * freed when it leaves or the flight ends.
 */
export function useGibsPatch(ground: RefObject<THREE.Object3D | null>, radius: number): MaterialPatch {
  const shipMode = useStore((s) => s.shipMode)
  const gl = useThree((s) => s.gl)
  const side = useMemo(
    () => (shipMode ? gibsPatchSide(flightTextureCap(gl.capabilities.maxTextureSize)) : 0),
    [shipMode, gl]
  )
  const patch = useMemo(() => createGibsPatch(side), [side])
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
