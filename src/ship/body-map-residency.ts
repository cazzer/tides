// Which surface map each planet and moon binds in ship mode (tides-0oi.7).
// three uploads a map the first time a draw samples it, and the bodies a few
// pixels across in the ship's frustum draw every frame, so holding a 2k map
// off the GPU means not binding it. Until a body grows past PROMOTE_RADIUS_PX
// its material samples a mip-tail proxy instead: a PROXY_WIDTH-wide texture
// holding the full map's own GPU mip levels from that width down, read back
// once from the uploaded map, which is then disposed (126 MB of maps on the
// low tier, against ~4 MB of proxies).
//
// The proxy is exact, not an approximation: its level k is the full map's
// level N + k, and a sample's LOD in it is the full map's less exactly N (the
// texel scale is a power of two smaller), so trilinear and anisotropic
// filtering read the same texels with the same weights, as long as the full
// map's LOD stays at or above N everywhere on the disk. That holds while the
// body's radius is under about PROXY_WIDTH / 2π px (~40 px), so promotion at
// 8 px (10 px at the latest, URGENT_RADIUS_PX) leaves two levels of margin.
// The one size-dependent term in the planets' shader, the detail's texel
// footprint from textureSize(uMap), is shut for both maps below ~80 px
// (pinned in body-map-residency.test.ts).
//
// Promotion uploads the full map (7-27 ms at 2k on an M4) and is a uniform
// swap, so the program doesn't change; it is sticky for the flight.
import * as THREE from 'three'

/** The proxy's top level, texels across. */
export const PROXY_WIDTH = 256
/** A body this many px in radius or more binds its full map. */
export const PROMOTE_RADIUS_PX = 8
/** Past this a promotion skips the frame's upload budget. */
export const URGENT_RADIUS_PX = 10

/**
 * The radius in screen px of a sphere of `radius` whose centre is `distance`
 * from the eye, for `screenPx` device rows with a `fovDeg` vertical FOV (the
 * same px per radian as limbFacetPx). From inside the sphere, a quarter turn.
 */
export function projectedRadiusPx(distance: number, radius: number, screenPx: number, fovDeg: number): number {
  const pxPerRadian = screenPx / 2 / Math.tan(((fovDeg / 2) * Math.PI) / 180)
  return Math.asin(Math.min(1, radius / distance)) * pxPerRadian
}

export type BodyMapTier = 'proxy' | 'full'

/** The map a body of `radiusPx` should bind; once promoted, always the full one. */
export function bodyMapTier(radiusPx: number, promoted: boolean): BodyMapTier {
  return promoted || radiusPx >= PROMOTE_RADIUS_PX ? 'full' : 'proxy'
}

/** Whether a body of `radiusPx` uploads its full map this frame. */
export function shouldUploadNow(radiusPx: number, slotFree: boolean): boolean {
  return bodyMapTier(radiusPx, false) === 'full' && (slotFree || radiusPx > URGENT_RADIUS_PX)
}

/**
 * The full map's level whose width is PROXY_WIDTH, or null where the map has
 * no such level (a power-of-two width above it).
 */
export function proxyBaseLevel(width: number): number | null {
  if (width <= PROXY_WIDTH || !Number.isInteger(Math.log2(width))) return null
  return Math.log2(width / PROXY_WIDTH)
}

export interface UploadBudget {
  /** Whether nothing has taken this frame's slot. */
  free(frameKey: number): boolean
  /** Takes this frame's slot: false if something already had. */
  take(frameKey: number): boolean
}

/** One heavy texture operation (an upload or a proxy's read-back) a frame. */
export function createUploadBudget(): UploadBudget {
  let taken: number | null = null
  return {
    free: (frameKey) => taken !== frameKey,
    take(frameKey) {
      if (taken === frameKey) return false
      taken = frameKey
      return true
    },
  }
}

/** The ship View's budget, keyed by its clock's elapsedTime (fixed within a frame). */
export const uploadSlot = createUploadBudget()

const isPowerOfTwo = (n: number) => n > 0 && Number.isInteger(Math.log2(n))

const MIPMAP_FILTERS: readonly THREE.TextureFilter[] = [
  THREE.NearestMipmapNearestFilter,
  THREE.NearestMipmapLinearFilter,
  THREE.LinearMipmapNearestFilter,
  THREE.LinearMipmapLinearFilter,
]

/**
 * The proxy for `map` from its GPU mip levels, `readLevel` giving a level's
 * RGBA bytes (null to give up), or null where the map can't have one: no
 * mip chain, a size that isn't a power of two, or too small to save.
 * The sampler state is the map's; the level count follows from the chain.
 */
export function buildMapProxy(
  map: THREE.Texture,
  readLevel: (level: number, width: number, height: number) => Uint8Array<ArrayBuffer> | null
): THREE.DataTexture | null {
  const { width, height } = map.image as { width: number; height: number }
  const base = proxyBaseLevel(width)
  if (base === null || !isPowerOfTwo(height) || height >> base < 1) return null
  if (!map.generateMipmaps || !MIPMAP_FILTERS.includes(map.minFilter)) return null
  const levels = Math.log2(Math.max(width, height)) + 1
  const mipmaps: { data: Uint8Array<ArrayBuffer>; width: number; height: number }[] = []
  for (let level = base; level < levels; level++) {
    const w = Math.max(1, width >> level)
    const h = Math.max(1, height >> level)
    const data = readLevel(level, w, h)
    if (!data) return null
    mipmaps.push({ data, width: w, height: h })
  }
  const top = mipmaps[0]
  const proxy = new THREE.DataTexture(top.data, top.width, top.height, THREE.RGBAFormat, THREE.UnsignedByteType)
  proxy.mipmaps = mipmaps as unknown as THREE.CompressedTextureMipmap[]
  proxy.generateMipmaps = false
  proxy.flipY = false
  proxy.premultiplyAlpha = false
  proxy.colorSpace = map.colorSpace
  proxy.anisotropy = map.anisotropy
  proxy.wrapS = map.wrapS
  proxy.wrapT = map.wrapT
  proxy.magFilter = map.magFilter
  proxy.minFilter = map.minFilter
  proxy.userData.fullMap = map
  proxy.needsUpdate = true
  return proxy
}

/** The full map a proxy stands in for, or undefined for any other texture. */
export function fullMapOf(texture: THREE.Texture | null | undefined): THREE.Texture | undefined {
  return (texture?.userData as { fullMap?: THREE.Texture } | undefined)?.fullMap
}

let scratchFramebuffer: WebGLFramebuffer | null = null

/**
 * `map`'s GPU mip `level` (`width` × `height`) as RGBA bytes, uploading the
 * map first if it isn't, or null on a lost context or an unreadable level.
 * readPixels returns an sRGB level's stored bytes unconverted, so the proxy
 * uploads the same texels. Leaves the read framebuffer as it found it.
 */
export function readTextureLevel(
  gl: THREE.WebGLRenderer,
  map: THREE.Texture,
  level: number,
  width: number,
  height: number
): Uint8Array<ArrayBuffer> | null {
  const ctx = gl.getContext() as WebGL2RenderingContext
  if (ctx.isContextLost()) return null
  gl.initTexture(map)
  const handle = (gl.properties.get(map) as { __webglTexture?: WebGLTexture }).__webglTexture
  if (!handle) return null
  const previous = ctx.getParameter(ctx.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
  scratchFramebuffer ??= ctx.createFramebuffer()
  ctx.bindFramebuffer(ctx.READ_FRAMEBUFFER, scratchFramebuffer)
  try {
    ctx.framebufferTexture2D(ctx.READ_FRAMEBUFFER, ctx.COLOR_ATTACHMENT0, ctx.TEXTURE_2D, handle, level)
    if (ctx.checkFramebufferStatus(ctx.READ_FRAMEBUFFER) !== ctx.FRAMEBUFFER_COMPLETE) return null
    const data = new Uint8Array(width * height * 4)
    ctx.readPixels(0, 0, width, height, ctx.RGBA, ctx.UNSIGNED_BYTE, data)
    return ctx.isContextLost() ? null : data
  } finally {
    // Detached, so the map's texture can be deleted.
    ctx.framebufferTexture2D(ctx.READ_FRAMEBUFFER, ctx.COLOR_ATTACHMENT0, ctx.TEXTURE_2D, null, 0)
    ctx.bindFramebuffer(ctx.READ_FRAMEBUFFER, previous)
  }
}

// By Source: the planets' maps come from useLoader's cache and the moons'
// from MoonBodies' loadedMaps, so a remount or a later flight finds its
// proxy built. Its levels stay in memory, so a restored context re-uploads it.
const proxies = new WeakMap<THREE.Source, THREE.DataTexture>()

let lossListening: HTMLCanvasElement | null = null

/** `map`'s proxy if one was built. */
export function cachedMapProxy(map: THREE.Texture): THREE.DataTexture | undefined {
  return proxies.get(map.source)
}

/** `map`'s proxy, built (one heavy operation) and cached if need be; null where it can't have one. */
export function mapProxy(gl: THREE.WebGLRenderer, map: THREE.Texture): THREE.DataTexture | null {
  const cached = proxies.get(map.source)
  if (cached) return cached
  const proxy = buildMapProxy(map, (level, width, height) => readTextureLevel(gl, map, level, width, height))
  if (proxy) proxies.set(map.source, proxy)
  if (lossListening !== gl.domElement) {
    lossListening = gl.domElement
    // The scratch framebuffer dies with the context.
    gl.domElement.addEventListener('webglcontextlost', () => {
      scratchFramebuffer = null
    })
  }
  return proxy
}

// Maps a proxy replaced, so ShipWarmup doesn't upload one it queued before.
const retired = new WeakSet<THREE.Texture>()

/** Frees `map` from the GPU while its proxy stands in for it. */
export function retireMap(map: THREE.Texture): void {
  retired.add(map)
  map.dispose()
}

/** Whether `texture` is a map a proxy stands in for. */
export function isRetiredMap(texture: THREE.Texture): boolean {
  return retired.has(texture)
}

/** Uploads `map` for the frame that swaps it in. */
export function promoteMap(gl: THREE.WebGLRenderer, map: THREE.Texture): void {
  retired.delete(map)
  gl.initTexture(map)
}
