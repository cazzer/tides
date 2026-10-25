// The GIBS streams' test rig (./gibsStream.ts), shared by the day and the
// night patch's tests: not part of the app.
import { expect, vi } from 'vitest'
import * as THREE from 'three'

/**
 * A ship `at` from the ground's centre, which sits at `groundAt` (0.2 R up
 * over the equator at 180° E/W unless `at` says), and a renderer that only
 * records the uploads. A patch's tile store outlives each test, so a test
 * wanting its own fetches flies somewhere else.
 */
export function setupGibsStream(
  fetchTile: (url: string) => Promise<Response>,
  at = new THREE.Vector3(-1.2, 0, 0),
  groundAt = new THREE.Vector3()
) {
  const bitmaps: { close: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('fetch', vi.fn(fetchTile))
  vi.stubGlobal('createImageBitmap', vi.fn(async () => {
    const bitmap = { width: 512, height: 512, close: vi.fn() }
    bitmaps.push(bitmap)
    return bitmap
  }))
  // Each tile is drawn, through the patch's pass, into the slot the target's viewport frames.
  const uploads: { x: number; y: number; width: number; scissored: boolean; mips: boolean; autoClear: boolean }[] = []
  const passes: THREE.Scene[] = []
  const targets: THREE.WebGLRenderTarget[] = []
  let bound: THREE.WebGLRenderTarget | null = null
  const gl = {
    autoClear: true,
    capabilities: { getMaxAnisotropy: () => 1 },
    initRenderTarget: vi.fn((t: THREE.WebGLRenderTarget) => {
      targets.push(t)
    }),
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
  camera.position.copy(groundAt).add(at)
  const ground = new THREE.Object3D()
  ground.position.copy(groundAt)
  ground.updateMatrixWorld()
  return { bitmaps, uploads, passes, targets, gl, camera, ground }
}

/** Lets the stubbed fetches and decodes resolve. */
export async function settleGibsStream() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}
