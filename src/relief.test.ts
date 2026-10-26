import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { DEFAULT_RELIEF, MAX_RELIEF, parseRelief, REFERENCE_RELIEF, RELIEF } from './relief'
import * as defaults from './cloud-layer'
import { MARCH_STEPS as DEFAULT_MARCH_STEPS } from './renderers/cloudShaders'
import { EARTH_RADIUS } from './ship/ship-bodies'

describe('parseRelief', () => {
  it('reads ?relief= as the factor, clamped to [1, 25]', () => {
    expect(parseRelief('?relief=12')).toBe(12)
    expect(parseRelief('?ship=1&relief=8.5&quality=high')).toBe(8.5)
    expect(parseRelief('?relief=25')).toBe(25)
    expect(parseRelief('?relief=0')).toBe(1)
    expect(parseRelief('?relief=-3')).toBe(1)
    expect(parseRelief('?relief=40')).toBe(25)
  })

  it('falls back to the default when absent or unreadable', () => {
    for (const search of ['', '?ship=1', '?relief=', '?relief=%20', '?relief=abc', '?relief=NaN', '?relief=Infinity']) {
      expect(parseRelief(search), search).toBe(DEFAULT_RELIEF)
    }
    expect(DEFAULT_RELIEF).toBe(12)
  })

  it('is the default outside a browser, at the default displacement', () => {
    expect(RELIEF).toBe(12)
    expect(defaults.TERRAIN_DISPLACEMENT).toBeCloseTo(0.036, 15)
    expect(defaults.TERRAIN_DISPLACEMENT).toBe(defaults.DEFAULT_TERRAIN_DISPLACEMENT)
  })

  it('keeps the clamp and the reference at 25, the exaggeration first tuned', () => {
    expect(MAX_RELIEF).toBe(25)
    expect(REFERENCE_RELIEF).toBe(25)
    expect(defaults.REFERENCE_TERRAIN_DISPLACEMENT).toBe(0.075)
  })
})

describe('?relief=25', () => {
  it('draws the ground as it was tuned', async () => {
    vi.resetModules()
    vi.stubGlobal('location', { search: '?relief=25' })
    try {
      const layer = await import('./cloud-layer')
      expect(layer.TERRAIN_DISPLACEMENT).toBe(0.075)
      expect(layer.DEFAULT_TERRAIN_DISPLACEMENT).toBe(defaults.DEFAULT_TERRAIN_DISPLACEMENT)
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })
})

describe('?relief=10', () => {
  it('moves every consumer of the displacement together', async () => {
    vi.resetModules()
    vi.stubGlobal('location', { search: '?ship=1&relief=10' })
    try {
      const layer = await import('./cloud-layer')
      const { groundHazeTop } = await import('./renderers/earth-shells')
      const { EARTH_SHELL_RADII, EARTH_GROUND_CLEARANCE } = await import('./ship/ship-bodies')
      const { terrainFloorRadius, TERRAIN_FALLBACK_GREY } = await import('./ship/terrain-floor')
      const { MORPH_FLOOR } = await import('./renderers/groundDisplacement')
      const { createCloudLayer, MARCH_STEPS } = await import('./renderers/cloudShaders')
      const { createEclipseShadow } = await import('./renderers/eclipseShadow')

      const td = 0.03
      expect(layer.TERRAIN_DISPLACEMENT).toBeCloseTo(td, 12)
      const drop = (defaults.TERRAIN_DISPLACEMENT - td) * defaults.TERRAIN_MAX_GREY
      expect(layer.CLOUD_LAYER_TOP).toBeCloseTo(defaults.CLOUD_LAYER_TOP - drop, 12)
      expect(layer.CLOUD_FLAT_ALTITUDE).toBeCloseTo(defaults.CLOUD_FLAT_ALTITUDE - drop, 12)
      expect(EARTH_SHELL_RADII[0]).toBeCloseTo(EARTH_RADIUS + layer.CLOUD_LAYER_TOP, 12)
      expect(EARTH_SHELL_RADII[1]).toBeCloseTo(EARTH_RADIUS + layer.CLOUD_FLAT_ALTITUDE, 12)
      expect(groundHazeTop(false)).toBe(layer.CLOUD_LAYER_TOP)
      expect(groundHazeTop(true)).toBe(layer.CLOUD_FLAT_ALTITUDE)
      const grey = 0.6
      expect(layer.cloudColumn(1, 5, grey, layer.TERRAIN_DISPLACEMENT).base).toBeCloseTo(td * grey + layer.CLOUD_CLEARANCE, 12)
      const up = new THREE.Vector3(0, 1, 0)
      expect(terrainFloorRadius(null, EARTH_RADIUS, up)).toBeCloseTo(
        EARTH_RADIUS + (td * TERRAIN_FALLBACK_GREY) / 255,
        12
      )
      // The highest stop stays under the limb sphere's fixed morph floor.
      expect(td * layer.TERRAIN_MAX_GREY + EARTH_GROUND_CLEARANCE).toBeLessThan(MORPH_FLOOR)

      // cloudShaders writes its constants into the GLSL at import: they
      // follow too, a thinner shell than the default's taking fewer march
      // steps (a thicker one, under a default below 10x, more).
      expect(Math.sign(MARCH_STEPS - DEFAULT_MARCH_STEPS)).toBe(Math.sign(td - defaults.TERRAIN_DISPLACEMENT))
      const clouds = createCloudLayer(createEclipseShadow('earth'), false)
      expect(clouds.shellAltitude).toBe(layer.CLOUD_LAYER_TOP)
      const source = clouds.material.vertexShader + clouds.material.fragmentShader
      expect(source).toContain(`#define TERRAIN_DISPLACEMENT ${td.toFixed(6)}`)
      expect(source).toContain(`#define MARCH_STEPS ${MARCH_STEPS}`)
      expect(source).not.toContain(`#define MARCH_STEPS ${DEFAULT_MARCH_STEPS}\n`)
      clouds.dispose()
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })
})
