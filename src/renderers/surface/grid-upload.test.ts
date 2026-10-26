import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import {
  createRectWriter,
  rectWritable,
  FULL_UPLOAD_SHARE,
  GridEdges,
  keepSourceOnClone,
  MAX_UPLOAD_RECTS,
  planRectUpload,
  type TexelRect,
} from './grid-upload'
import { trackUploads } from './tile-upload'

/** The texture fields three's getTextureCacheKey reads (r180; pinned below). */
const CACHE_KEY_FIELDS = ['wrapS', 'wrapT', 'wrapR', 'magFilter', 'minFilter', 'anisotropy', 'internalFormat', 'format', 'type', 'generateMipmaps', 'premultiplyAlpha', 'flipY', 'unpackAlignment', 'colorSpace']

const rect = (x: number, y: number, width: number, height: number): TexelRect => ({ x, y, width, height })

/** A padded grid as the cache makes them (514 = 512 + border), R32F. */
const grid = (side = 514) => new THREE.DataTexture(new Float32Array(side * side), side, side, THREE.RedFormat, THREE.FloatType)

describe('planRectUpload (tides-zmw.9.27)', () => {
  it("keeps a neighbour's border as the one rect it is", () => {
    expect(planRectUpload([rect(513, 1, 1, 512)], 514, 514)).toEqual([rect(513, 1, 1, 512)])
  })

  it("keeps the four edges apart (they don't line up)", () => {
    const edges = [rect(0, 1, 1, 512), rect(513, 1, 1, 512), rect(1, 0, 512, 1), rect(1, 513, 512, 1)]
    expect(planRectUpload(edges, 514, 514)).toEqual(edges)
  })

  it('drops a rect written twice (a neighbour made again) and one inside another', () => {
    expect(planRectUpload([rect(0, 1, 1, 512), rect(0, 1, 1, 512), rect(0, 10, 1, 4)], 514, 514)).toEqual([rect(0, 1, 1, 512)])
  })

  it('joins rects that line up: a corner and the column it ends, and in any order', () => {
    expect(planRectUpload([rect(0, 0, 1, 1), rect(0, 1, 1, 512), rect(0, 513, 1, 1)], 514, 514)).toEqual([rect(0, 0, 1, 514)])
    expect(planRectUpload([rect(0, 513, 1, 1), rect(0, 0, 1, 1), rect(0, 1, 1, 512)], 514, 514)).toEqual([rect(0, 0, 1, 514)])
    expect(planRectUpload([rect(1, 0, 512, 1), rect(513, 0, 1, 1)], 514, 514)).toEqual([rect(1, 0, 513, 1)])
  })

  it('skips empty rects', () => {
    expect(planRectUpload([rect(3, 3, 0, 5), rect(4, 4, 2, 0)], 514, 514)).toEqual([])
  })

  it(`sends the whole texture past ${FULL_UPLOAD_SHARE} of it changed, or past ${MAX_UPLOAD_RECTS} rects`, () => {
    // 65 full rows: just over an eighth
    expect(planRectUpload([rect(0, 0, 514, 65)], 514, 514)).toEqual([rect(0, 0, 514, 514)])
    expect(planRectUpload([rect(0, 0, 514, 64)], 514, 514)).toEqual([rect(0, 0, 514, 64)])
    const scattered = Array.from({ length: MAX_UPLOAD_RECTS + 1 }, (_, i) => rect(2 * i + 1, 2 * i + 1, 1, 1))
    expect(planRectUpload(scattered, 514, 514)).toEqual([rect(0, 0, 514, 514)])
    expect(planRectUpload(scattered.slice(1), 514, 514)).toHaveLength(MAX_UPLOAD_RECTS)
  })
})

describe('createRectWriter (tides-zmw.9.27)', () => {
  /** A renderer whose GL records its calls; `known` textures have a WebGL texture. */
  function fakeRenderer(known: THREE.Texture[]) {
    const calls: unknown[][] = []
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        calls.push([name, ...args])
    const gl = {
      TEXTURE_2D: 'T2D',
      RED: 'RED',
      FLOAT: 'FLOAT',
      UNPACK_FLIP_Y_WEBGL: 'FLIP',
      UNPACK_PREMULTIPLY_ALPHA_WEBGL: 'PREMUL',
      UNPACK_ALIGNMENT: 'ALIGN',
      UNPACK_ROW_LENGTH: 'ROW',
      UNPACK_SKIP_PIXELS: 'SKIPX',
      UNPACK_SKIP_ROWS: 'SKIPY',
      pixelStorei: record('pixelStorei'),
      texSubImage2D: record('texSubImage2D'),
      getParameter: () => {
        throw new Error('reads nothing back')
      },
    }
    const glTextures = new Map(known.map((t, i) => [t, { id: i }]))
    const renderer = {
      getContext: () => gl,
      properties: { get: (t: THREE.Texture) => ({ __webglTexture: glTextures.get(t) }) },
      state: { bindTexture: record('bindTexture') },
    }
    return { renderer: renderer as unknown as THREE.WebGLRenderer, calls, glTextures }
  }

  it("binds the texture's shared WebGL texture and sends each rect from its data, rows a texture width apart", () => {
    const target = grid()
    const { renderer, calls, glTextures } = fakeRenderer([target])
    const before = { version: target.version, source: target.source.version }
    const bytes = createRectWriter(renderer)(target, [rect(513, 1, 1, 512), rect(0, 0, 1, 1)])
    expect(bytes).toBe((512 + 1) * 4)
    const data = target.image.data
    expect(calls).toEqual([
      ['bindTexture', 'T2D', glTextures.get(target)],
      ['pixelStorei', 'FLIP', false],
      ['pixelStorei', 'PREMUL', false],
      ['pixelStorei', 'ALIGN', 1],
      ['pixelStorei', 'ROW', 514],
      ['pixelStorei', 'SKIPX', 0],
      ['pixelStorei', 'SKIPY', 0],
      ['texSubImage2D', 'T2D', 0, 513, 1, 1, 512, 'RED', 'FLOAT', data, 1 * 514 + 513],
      ['texSubImage2D', 'T2D', 0, 0, 0, 1, 1, 'RED', 'FLOAT', data, 0],
      // three's uploads assume 0
      ['pixelStorei', 'ROW', 0],
    ])
    // not marked for upload
    expect({ version: target.version, source: target.source.version }).toEqual(before)
  })

  it('sends nothing for a texture it would write wrongly: not one float channel, flipped, or with mipmaps', () => {
    const odd: THREE.DataTexture[] = []
    const add = (change: (t: THREE.DataTexture) => void) => {
      const t = grid(6)
      change(t)
      odd.push(t)
    }
    add((t) => (t.format = THREE.RGBAFormat))
    add((t) => (t.type = THREE.HalfFloatType))
    add((t) => (t.flipY = true))
    add((t) => (t.generateMipmaps = true))
    add((t) => (t.minFilter = THREE.LinearMipmapLinearFilter))
    add((t) => (t.mipmaps = [{ data: new Float32Array(9), width: 3, height: 3 }] as unknown as THREE.DataTexture['mipmaps']))
    const { renderer, calls } = fakeRenderer(odd)
    const write = createRectWriter(renderer)
    for (const t of odd) expect(write(t, [rect(0, 1, 1, 4)])).toBeNull()
    expect(calls).toEqual([])
    const linear = grid(6)
    linear.minFilter = linear.magFilter = THREE.LinearFilter
    expect(rectWritable(linear)).toBe(true)
  })

  it('sends nothing for a texture with no GPU copy', () => {
    const { renderer, calls } = fakeRenderer([])
    expect(createRectWriter(renderer)(grid(), [rect(0, 1, 1, 512)])).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('keepSourceOnClone (tides-zmw.9.27)', () => {
  it("lets a clone share the Source without bumping its version (three's copy would)", () => {
    const plain = grid(6)
    const v = plain.source.version
    plain.clone()
    expect(plain.source.version).toBe(v + 1) // three's own clone: the original counts as changed

    const kept = keepSourceOnClone(grid(6))
    const version = kept.source.version
    const clone = kept.clone()
    expect(clone.source).toBe(kept.source)
    expect(clone.version).toBeGreaterThan(0) // its first draw still binds the shared texture
    expect(kept.source.version).toBe(version)
    expect(kept.clone()).not.toBe(clone)
  })

  // three keys its WebGL textures by these (WebGLTextures getTextureCacheKey,
  // pinned below): a clone differing in any would get its own, which the
  // rects GridEdges writes into the grid's would never reach
  it("gives the clone every parameter three keys its WebGL textures by, so it shares the grid's", () => {
    const g = grid(6)
    g.minFilter = g.magFilter = THREE.LinearFilter // as makeGrid's 'linear'
    const kept = keepSourceOnClone(g)
    const clone = kept.clone()
    for (const key of CACHE_KEY_FIELDS) expect([key, clone[key as keyof THREE.Texture]]).toEqual([key, kept[key as keyof THREE.Texture]])
  })

  it('puts the version back even if the clone throws', () => {
    const kept = keepSourceOnClone(grid(6))
    const version = kept.source.version
    vi.spyOn(THREE.DataTexture.prototype, 'copy').mockImplementationOnce(function (this: THREE.DataTexture, from: THREE.Texture) {
      from.source.needsUpdate = true
      throw new Error('copy failed')
    })
    expect(() => kept.clone()).toThrow('copy failed')
    expect(kept.source.version).toBe(version)
    vi.restoreAllMocks()
  })

  it('keeps a change not yet sent', () => {
    const kept = keepSourceOnClone(grid(6))
    const sent = trackUploads(() => {})
    sent.upload(kept)
    kept.needsUpdate = true // changed after it was sent
    kept.clone()
    expect(sent.isCurrent(kept)).toBe(false)
  })
})

describe('GridEdges (tides-zmw.9.27)', () => {
  function setup() {
    const uploaded: THREE.Texture[] = []
    const tracked = trackUploads((texture) => uploaded.push(texture))
    const writes: [THREE.Texture, TexelRect[]][] = []
    const edges = new GridEdges((texture, rects) => {
      writes.push([texture, [...rects]])
      return rects.reduce((sum, r) => sum + r.width * r.height * 4, 0)
    }, tracked)
    return { uploaded, tracked, writes, edges }
  }

  it("accumulates a sent grid's rects until the flush, then writes them alone, once, without marking it", () => {
    const { uploaded, tracked, writes, edges } = setup()
    const a = grid()
    const b = grid()
    tracked.upload(a)
    tracked.upload(b)
    uploaded.length = 0
    edges.mark(a, rect(513, 1, 1, 512))
    edges.mark(a, rect(513, 513, 1, 1))
    edges.mark(b, rect(0, 1, 1, 512))
    expect(edges.pending).toBe(2)
    expect(writes).toHaveLength(0)
    edges.flush()
    expect(writes).toEqual([
      [a, [rect(513, 1, 1, 513)]],
      [b, [rect(0, 1, 1, 512)]],
    ])
    expect(uploaded).toHaveLength(0)
    expect(tracked.isCurrent(a) && tracked.isCurrent(b)).toBe(true)
    expect(edges.stats).toMatchObject({ writes: 2, rects: 2, bytes: (513 + 512) * 4, full: 0 })
    expect(edges.pending).toBe(0)
    edges.flush()
    expect(writes).toHaveLength(2)
  })

  it('sends a grid whole when its GPU copy is behind or never sent (a write would leave the rest stale)', () => {
    const { uploaded, tracked, writes, edges } = setup()
    const never = grid()
    const behind = grid()
    tracked.upload(behind)
    behind.needsUpdate = true
    uploaded.length = 0
    edges.mark(never, rect(0, 1, 1, 512))
    edges.mark(behind, rect(0, 1, 1, 512))
    const version = never.version
    edges.flush()
    expect(writes).toHaveLength(0)
    expect(uploaded).toEqual([never, behind])
    expect(never.version).toBe(version + 1) // marked, so three sends it
    expect(edges.stats).toMatchObject({ writes: 0, full: 2, fullBytes: 2 * 514 * 514 * 4 })
  })

  it("sends a grid whole when the writer finds no GPU copy of it", () => {
    const uploaded: THREE.Texture[] = []
    const tracked = trackUploads((texture) => uploaded.push(texture))
    const edges = new GridEdges(() => null, tracked)
    const a = grid()
    tracked.upload(a)
    uploaded.length = 0
    edges.mark(a, rect(0, 1, 1, 512))
    edges.flush()
    expect(uploaded).toEqual([a])
    expect(edges.stats).toMatchObject({ writes: 0, full: 1 })
  })

  it('sends a grid whole when most of it changed', () => {
    const { uploaded, tracked, writes, edges } = setup()
    const a = grid()
    tracked.upload(a)
    uploaded.length = 0
    edges.mark(a, rect(0, 0, 514, 200))
    edges.flush()
    expect(writes).toHaveLength(0)
    expect(uploaded).toEqual([a])
  })
})

// What createRectWriter, keepSourceOnClone and GridEdges rely on in three r180's
// WebGL renderer: recheck on a three bump.
describe('three internals (pinned to r180)', () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), 'node_modules/three/src', file), 'utf8')

  it("keeps each texture's WebGL texture in renderer.properties, and binds through the state cache", () => {
    expect(THREE.REVISION).toBe('180')
    const textures = read('renderers/webgl/WebGLTextures.js')
    expect(textures).toContain('textureProperties.__webglTexture = webglTextures[ textureCacheKey ].texture;')
    expect(read('renderers/webgl/WebGLState.js')).toContain('function bindTexture( webglType, webglTexture, webglSlot ) {')
    // three's own CPU sub-rect copy reads the pixel store back (a GPU round trip each): not used
    expect(read('renderers/WebGLRenderer.js')).toContain('const currentUnpackRowLen = _gl.getParameter( _gl.UNPACK_ROW_LENGTH );')
  })

  it('shares one WebGL texture per Source and parameters, uploading only when the Source version moves', () => {
    const textures = read('renderers/webgl/WebGLTextures.js')
    const key = textures.slice(textures.indexOf('function getTextureCacheKey( texture ) {'), textures.indexOf("return array.join();"))
    expect([...key.matchAll(/array\.push\( texture\.(\w+)/g)].map((m) => m[1])).toEqual(CACHE_KEY_FIELDS)
    expect(textures).toContain('const textureCacheKey = getTextureCacheKey( texture );')
    expect(textures).toContain('if ( source.version !== sourceProperties.__version || forceUpload === true ) {')
  })
})
