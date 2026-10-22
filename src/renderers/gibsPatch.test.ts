import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer } from './cloudShaders'
import { groundDetailPatch } from './groundDetail'
import { createGibsPatch } from './gibsPatch'
import { nightLightsPatch } from './nightLights'
import { poleSmoothingPatch } from './poleSmoothing'

function phongShader() {
  return {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
    vertexShader: THREE.ShaderLib.phong.vertexShader,
    fragmentShader: THREE.ShaderLib.phong.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms
}

describe('GIBS patch on the ground', () => {
  it('adds its detail after the (pole-smoothed) albedo and hands its cover to the ground detail', () => {
    const eclipse = createEclipseShadow('earth')
    const clouds = createCloudLayer(eclipse, false)
    const gibs = createGibsPatch(8)
    const patch = composePatches(
      eclipse.material,
      clouds.groundPatch,
      nightLightsPatch(clouds.uniforms.uSunDir),
      poleSmoothingPatch(),
      groundDetailPatch(false),
      gibs.material
    )
    const shader = phongShader()
    patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)

    const frag = shader.fragmentShader
    const at = (s: string) => {
      expect(frag).toContain(s)
      return frag.indexOf(s)
    }
    const blend = at('diffuseColor.rgb = sRGBTransferEOTF(')
    expect(at('sampledDiffuseColor = poleSmoothed(')).toBeLessThan(blend)
    expect(blend).toBeLessThan(at('#include <color_fragment>'))
    // The ground detail reads the albedo and the patch's cover after both.
    const cover = at('groundDetailFine = gibsCover;')
    expect(at('float groundDetailFine = 0.0;')).toBeLessThan(cover)
    expect(cover).toBeLessThan(at('vec4 detail = groundDetail('))
    // Night lights and the specular mask are untouched: the albedo is all
    // the patch writes.
    expect(blend).toBeLessThan(at('#include <specularmap_fragment>'))
    const gibsCode = frag.slice(frag.indexOf('float gibsCover'), at('#include <color_fragment>'))
    expect(gibsCode).not.toMatch(/totalEmissiveRadiance|specularStrength|vCloud/)
    expect(Object.keys(shader.uniforms)).toEqual(expect.arrayContaining(['uGibsPatch', 'uGibsMask', 'uGibsOrigin', 'uGibsActive']))
    expect(patch.customProgramCacheKey()).toContain('gibs-patch-8')
    clouds.dispose()
    gibs.release()
  })

  it('leaves the material alone where the device takes no patch', () => {
    const shader = phongShader()
    const none = createGibsPatch(0)
    none.material.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    expect(shader.fragmentShader).toBe(THREE.ShaderLib.phong.fragmentShader)
    expect(none.material.customProgramCacheKey()).toBe('')
  })
})

describe('GIBS patch streaming', () => {
  afterEach(() => vi.unstubAllGlobals())

  // A ship 0.2 R up over the equator (at 180° E/W unless `at` says), and a
  // renderer that only records the uploads. The tile store outlives each
  // test, so a test wanting its own fetches flies somewhere else.
  function setup(fetchTile: (url: string) => Promise<Response>, at = new THREE.Vector3(-1.2, 0, 0)) {
    const bitmaps: { close: ReturnType<typeof vi.fn> }[] = []
    vi.stubGlobal('fetch', vi.fn(fetchTile))
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      const bitmap = { width: 512, height: 512, close: vi.fn() }
      bitmaps.push(bitmap)
      return bitmap
    }))
    // Each tile is drawn, recoloured, into the slot the target's viewport frames.
    const uploads: { x: number; y: number; width: number; scissored: boolean; mips: boolean; autoClear: boolean }[] = []
    const passes: THREE.Scene[] = []
    let bound: THREE.WebGLRenderTarget | null = null
    const gl = {
      autoClear: true,
      capabilities: { getMaxAnisotropy: () => 1 },
      initRenderTarget: vi.fn(),
      getRenderTarget: () => bound,
      setRenderTarget: vi.fn((t: THREE.WebGLRenderTarget | null) => {
        bound = t
      }),
      render: vi.fn((scene: THREE.Scene) => {
        if (!bound) throw new Error('drew a tile to the screen')
        const material = (scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial
        const tile = material.uniforms.uTile.value as THREE.Texture
        // Read raw, unflipped, and still open when drawn.
        expect(tile.colorSpace).toBe(THREE.NoColorSpace)
        expect(tile.flipY).toBe(false)
        expect((tile.image as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled()
        passes.push(scene)
        const { x, y, z } = bound.viewport
        const scissored = bound.scissorTest && bound.scissor.equals(bound.viewport)
        uploads.push({ x, y, width: z, scissored, mips: bound.texture.generateMipmaps, autoClear: gl.autoClear })
      }),
    } as unknown as THREE.WebGLRenderer
    const camera = new THREE.PerspectiveCamera()
    camera.position.copy(at)
    const ground = new THREE.Object3D()
    ground.updateMatrixWorld()
    return { bitmaps, uploads, passes, gl, camera, ground }
  }
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  }

  it('fetches six at a time, uploads two a frame with one mip rebuild, and frees everything on release', async () => {
    let n = 0
    const { bitmaps, uploads, passes, gl, camera, ground } = setup(async (url) => {
      n++
      return new Response(url)
    })
    const patch = createGibsPatch(4)
    patch.update(gl, camera, ground, 1, 0)
    expect(n).toBe(6)
    expect(gl.initRenderTarget).not.toHaveBeenCalled()
    await settle()
    patch.update(gl, camera, ground, 1, 16)
    expect(gl.initRenderTarget).toHaveBeenCalledTimes(1)
    expect(uploads.map((u) => u.mips)).toEqual([false, true])
    // Tiles land in their slots, 512 px apart, without clearing the rest,
    // and the renderer is left as it was.
    for (const u of uploads) {
      expect(u.x % 512).toBe(0)
      expect(u.y % 512).toBe(0)
      expect(u.width).toBe(512)
      expect(u.scissored).toBe(true)
      expect(u.autoClear).toBe(false)
    }
    expect(gl.getRenderTarget()).toBeNull()
    expect(gl.autoClear).toBe(true)
    expect(bitmaps.filter((b) => b.close.mock.calls.length > 0)).toHaveLength(2)
    // The recolour's textures and program go with the patch.
    const material = (passes[0].children[0] as THREE.Mesh).material as THREE.ShaderMaterial
    const disposed = [material, material.uniforms.uTile.value, material.uniforms.uLut.value].map((o: THREE.EventDispatcher<{ dispose: object }>) => {
      const listener = vi.fn()
      o.addEventListener('dispose', listener)
      return listener
    })
    patch.release()
    expect(bitmaps.every((b) => b.close.mock.calls.length > 0)).toBe(true)
    for (const listener of disposed) expect(listener).toHaveBeenCalled()
    patch.release()
  })

  it('drops tiles that land after a release', async () => {
    const { bitmaps, gl, camera, ground } = setup(async (url) => new Response(url))
    const patch = createGibsPatch(4)
    patch.update(gl, camera, ground, 1, 0)
    patch.release()
    await settle()
    expect(bitmaps).toHaveLength(6)
    expect(bitmaps.every((b) => b.close.mock.calls.length > 0)).toBe(true)
  })

  it('leaves a failed tile to the day map and tries it again later', async () => {
    const urls: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { gl, camera, ground, uploads } = setup(async (url) => {
      urls.push(url)
      throw new Error('offline')
    }, new THREE.Vector3(0, 0, 1.2))
    const patch = createGibsPatch(4)
    patch.update(gl, camera, ground, 1, 0)
    await settle()
    patch.update(gl, camera, ground, 1, 16)
    expect(uploads).toHaveLength(0)
    expect(gl.initRenderTarget).not.toHaveBeenCalled()
    // Offline, one warning for all of them.
    expect(warn).toHaveBeenCalledTimes(1)
    await settle()
    patch.update(gl, camera, ground, 1, 32)
    await settle()
    const tried = urls.length
    // All 16 tried once, none again before RETRY_MS.
    expect(tried).toBe(16)
    patch.update(gl, camera, ground, 1, 1_000)
    expect(urls.length).toBe(tried)
    patch.update(gl, camera, ground, 1, 40_000)
    expect(urls.length).toBeGreaterThan(tried)
    patch.release()
    warn.mockRestore()
  })
})
