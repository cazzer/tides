// The ground haze on the streamed tiles (tides-zmw.9.7, as a composer slot
// since tides-zmw.9.16): the globe's surface variant, its text unchanged.
import { describe, expect, it } from 'vitest'
import { tileHaze } from './tile-haze'
import { createTileComposer, type TerrainPhongMaterial } from './tile-material'
import { compiled, fakeLink, tileMesh } from './tile-test-fixtures'

describe('the haze on the tiles', () => {
  it('lays the globe\'s surface variant on the haze\'s uniforms and frame', () => {
    const link = fakeLink()
    const mesh = tileMesh()
    const composer = createTileComposer(link, [{ name: 'haze', adapter: tileHaze }])
    expect(composer.key).toBe('surface-tile:surface-base+ground-haze-surface')
    composer.prepare(mesh, {})
    const shader = compiled(mesh.material as TerrainPhongMaterial)
    expect(shader.fragmentShader).toContain('vec4 haze = groundHaze(vGroundHazeEye, vGroundHazeRay, cover);')
    expect(shader.vertexShader).toContain('vGroundHazeRay = uGroundHazeViewToLocal * mvPosition.xyz;')
    expect(shader.uniforms.uGroundHazeViewToLocal).toBe(link.haze.frame.uGroundHazeViewToLocal)
    expect(shader.uniforms.uSurfaceViewToGround).toBe(shader.uniforms.uGroundHazeViewToLocal)
  })
})
