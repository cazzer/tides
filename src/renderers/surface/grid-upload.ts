// Keeps an elevation grid's GPU copy current without sending it whole again
// (tides-zmw.9.27). A grid (514x514 R32F, 1 MB) goes up once, as it is made
// (terrain-internals.ts makeGrid). Two things used to send it again, whole,
// at the next draw of a tile reading it:
//
// - Each tile's clone of it (the terrain plugin's displacement map): three's
//   Texture.copy marks the clone for update, which bumps the version of the
//   Source it shares with the grid, so the GPU copy counted as stale.
//   keepSourceOnClone puts the shared version back: a clone of a sent grid
//   has nothing to send (three binds the grid's WebGL texture for it: same
//   Source, same parameters, one texture).
// - Stitching: a new grid writes one border row or column (or a corner
//   texel) into each loaded neighbour, and the library marks the whole
//   neighbour for update. GridEdges keeps those writes as texel rects per
//   grid and sends just them (a sub-rect texSubImage2D from the grid's own
//   data, rows UNPACK_ROW_LENGTH apart) straight into the WebGL texture the
//   grid and its clones share. 2 KB a neighbour instead of 1 MB.
//
// Writing into the shared texture also fixes what the full re-upload never
// did: a clone's own version is fixed after its first draw, so a tile already
// drawn never sent its grid again, and showed the border its grid had then
// (the neighbour's edge missing) until some new tile reading the grid drew:
// half the drawn grids at a settled 2 km pose held stale borders.
//
// Not through three's own partial uploads. texture.addUpdateRange's ranges
// are runs within one row (a stitched column would be 512 calls), run only
// in a full upload's place, at a version change every clone would repeat.
// copyTextureToTexture does copy a sub-rect from the CPU, but reads five
// pixel-store parameters back first (gl.getParameter): a synchronous round
// trip to the GPU process per call, which under a loaded GPU took 8 ms on
// average and up to 200 ms (headless, 3 spinning pages: 3450 calls, 29 s in
// 40 s; long tasks > 50 ms 247 against 21 for the same writes made as
// below). createRectWriter sets the state it needs instead of reading it.
import type { DataTexture, Source, Texture, WebGLRenderer } from 'three'

/** A rectangle of texels: x, y the first column and row (rows as the data's). */
export interface TexelRect {
  x: number
  y: number
  width: number
  height: number
}

/** Past this share of the grid's texels dirty, it goes up whole. */
export const FULL_UPLOAD_SHARE = 1 / 8

/** Past this many separate rects after merging, it goes up whole. */
export const MAX_UPLOAD_RECTS = 16

const contains = (a: TexelRect, b: TexelRect) =>
  a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height

/** The one rect covering both, if they're the same column span and touch or overlap in rows (or the same row span, columns). */
function joined(a: TexelRect, b: TexelRect): TexelRect | null {
  if (a.x === b.x && a.width === b.width && a.y <= b.y + b.height && b.y <= a.y + a.height) {
    const y = Math.min(a.y, b.y)
    return { x: a.x, y, width: a.width, height: Math.max(a.y + a.height, b.y + b.height) - y }
  }
  if (a.y === b.y && a.height === b.height && a.x <= b.x + b.width && b.x <= a.x + a.width) {
    const x = Math.min(a.x, b.x)
    return { x, y: a.y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: a.height }
  }
  return null
}

/**
 * What to send of a width x height texture with `rects` changed: the rects,
 * any inside another dropped and any that line up joined (a corner texel
 * and the column it ends), or the whole texture as one rect if what's left
 * is more than FULL_UPLOAD_SHARE of it or more than MAX_UPLOAD_RECTS rects.
 */
export function planRectUpload(rects: readonly TexelRect[], width: number, height: number): TexelRect[] {
  const out: TexelRect[] = []
  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue
    let next: TexelRect = { ...rect }
    // fold it into what's kept until nothing more joins or contains it
    for (let i = 0; i < out.length; ) {
      const kept = out[i]
      if (contains(kept, next)) {
        next = kept
        out.splice(i, 1)
        i = 0
        continue
      }
      const both = contains(next, kept) ? next : joined(kept, next)
      if (both) {
        next = both
        out.splice(i, 1)
        i = 0
        continue
      }
      i++
    }
    out.push(next)
  }
  const area = out.reduce((sum, r) => sum + r.width * r.height, 0)
  if (out.length > MAX_UPLOAD_RECTS || area > width * height * FULL_UPLOAD_SHARE) return [{ x: 0, y: 0, width, height }]
  return out
}

/**
 * Sends `rects` of the texture's data into its GPU copy; returns the bytes
 * sent, or null if the texture has no GPU copy to write into (never sent).
 */
export type RectWriter = (texture: DataTexture, rects: readonly TexelRect[]) => number | null

/** The renderer's parts a RectWriter uses. */
export type RectWriterRenderer = Pick<WebGLRenderer, 'getContext' | 'properties' | 'state'>

/**
 * A RectWriter for single-channel float textures (the grids) with no
 * mipmaps: binds the texture's WebGL texture through three's state cache
 * (renderer.properties' __webglTexture, which the texture's clones share)
 * and sends each rect with texSubImage2D from the texture's data, rows
 * UNPACK_ROW_LENGTH apart. Sets the unpack state it needs, as three does
 * before each of its uploads, and leaves UNPACK_ROW_LENGTH at 0 (three's
 * uploads assume it). Reads nothing back from the GL. The texture's versions
 * are untouched.
 */
export function createRectWriter(renderer: RectWriterRenderer): RectWriter {
  return (texture, rects) => {
    const glTexture = (renderer.properties.get(texture) as { __webglTexture?: WebGLTexture }).__webglTexture
    if (!glTexture) return null
    const gl = renderer.getContext() as WebGL2RenderingContext
    const image = texture.image as unknown as { data: Float32Array; width: number; height: number }
    renderer.state.bindTexture(gl.TEXTURE_2D, glTexture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, texture.unpackAlignment)
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, image.width)
    let bytes = 0
    try {
      for (const { x, y, width, height } of rects) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, gl.RED, gl.FLOAT, image.data, y * image.width + x)
        bytes += width * height * image.data.BYTES_PER_ELEMENT
      }
    } finally {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
    }
    return bytes
  }
}

/**
 * Makes `texture.clone()` leave the Source it shares as it was: three's
 * Texture.copy marks the copy for update, bumping the shared Source's
 * version, which would make the original's GPU copy count as stale and go
 * up whole at the clone's first draw. The copy's own version still moves (its
 * first draw binds the shared WebGL texture), and a Source already changed
 * and not yet sent stays so.
 */
export function keepSourceOnClone<T extends Texture>(texture: T): T {
  const clone = texture.clone.bind(texture)
  texture.clone = () => {
    const { source } = texture
    const version = source.version
    const copy = clone()
    source.version = version
    return copy
  }
  return texture
}

/** GridEdges' running totals (never reset). */
export interface GridEdgeStats {
  /** Grids whose changed rects were sent (once per flush each). */
  writes: number
  /** Rects sent. */
  rects: number
  /** Bytes the rects held. */
  bytes: number
  /** Grids sent whole instead (their GPU copy wasn't current or found, or too much had changed). */
  full: number
  /** Bytes those held. */
  fullBytes: number
}

/** What GridEdges needs of the upload tracker (tile-upload.ts trackUploads). */
export interface EdgeUploadTarget {
  /** Sends the texture whole (the renderer's initTexture, tracked). */
  upload: (texture: Texture) => void
  /** Whether the texture's GPU copy holds its data as last changed (by version). */
  isCurrent: (texture: Texture) => boolean
}

/**
 * The texel rects written into uploaded grids since they were last sent,
 * per grid (by its Source), and sending them: mark() as stitching writes a
 * border, flush() once the stitch is done. A grid whose GPU copy isn't
 * current, or with most of it changed, goes up whole.
 */
export class GridEdges {
  private readonly dirty = new Map<Source, { texture: DataTexture; rects: TexelRect[] }>()
  readonly stats: GridEdgeStats = { writes: 0, rects: 0, bytes: 0, full: 0, fullBytes: 0 }

  constructor(
    private readonly write: RectWriter,
    private readonly target: EdgeUploadTarget
  ) {}

  /** Grids waiting for a flush. */
  get pending(): number {
    return this.dirty.size
  }

  /** Notes that `rect` of the texture's data has changed (the data itself is written by the caller). */
  mark(texture: DataTexture, rect: TexelRect): void {
    const entry = this.dirty.get(texture.source)
    if (entry) entry.rects.push(rect)
    else this.dirty.set(texture.source, { texture, rects: [rect] })
  }

  /** Sends every marked grid's changed rects (or the grid whole), and forgets them. */
  flush(): void {
    for (const { texture, rects } of this.dirty.values()) {
      const { width, height } = texture.image as { width: number; height: number }
      const plan = planRectUpload(rects, width, height)
      const whole = plan.length === 1 && plan[0].width === width && plan[0].height === height
      const sent = !whole && this.target.isCurrent(texture) ? this.write(texture, plan) : null
      if (sent !== null) {
        this.stats.writes++
        this.stats.rects += plan.length
        this.stats.bytes += sent
      } else {
        texture.needsUpdate = true
        this.target.upload(texture)
        this.stats.full++
        this.stats.fullBytes += (texture.image as { data: ArrayBufferView }).data.byteLength
      }
    }
    this.dirty.clear()
  }
}
