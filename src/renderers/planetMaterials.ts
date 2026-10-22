// The lit-globe material and its uniforms, shared by the planets
// (PlanetRenderer.tsx) and the major moons (moons/MoonBodies.tsx). The
// scene's directional sunlight is aimed at the Earth, so these take the Sun's
// direction in the body's own frame instead (sunDirection).
import * as THREE from 'three'
import { MAX_RING_BANDS, sunDirectionInFrame } from './planetFrame'
import { AMBIENT_COLOR, AMBIENT_INTENSITY, SUNLIGHT_INTENSITY } from '../lighting'
import planetVertex from '../shaders/planet/vertex.glsl'
import planetFragment from '../shaders/planet/fragment.frag'

/** The scene's ambient fill, as the planets' shaders take it. */
export const AMBIENT = new THREE.Color(AMBIENT_COLOR).multiplyScalar(AMBIENT_INTENSITY)

/**
 * A `uSunDir` uniform and the mesh's onBeforeRender that keeps it current,
 * from the mesh's final transform for this frame (three calls it with the
 * mesh as `this`).
 */
export function sunDirection(): {
  uniform: { value: THREE.Vector3 }
  onBeforeRender: (this: THREE.Object3D) => void
} {
  const uniform = { value: new THREE.Vector3(1, 0, 0) }
  function onBeforeRender(this: THREE.Object3D) {
    sunDirectionInFrame(this, uniform.value)
  }
  return { uniform, onBeforeRender }
}

export type BandUniforms = {
  uBands: { value: THREE.Vector3[] }
  uBandCount: { value: number }
}

export function bandUniforms(): BandUniforms {
  return {
    uBands: {
      value: Array.from({ length: MAX_RING_BANDS }, () => new THREE.Vector3()),
    },
    uBandCount: { value: 0 },
  }
}

/**
 * The globes' material: Sun-lit diffuse (Minnaert, uMinnaert 1 is Lambert)
 * with the scene's ambient fill, lit from `sunDir` (sunDirection). Untextured
 * and unshadowed, it is a plain uColor; every such globe (the planets' and
 * the moons', tides-2hv.8) shares one compiled program.
 */
export function planetSurfaceMaterial(
  sunDir: { value: THREE.Vector3 },
  {
    map = null,
    ringMap = null,
    shadowed = false,
  }: { map?: THREE.Texture | null; ringMap?: THREE.Texture | null; shadowed?: boolean } = {}
): THREE.ShaderMaterial {
  const defines: Record<string, unknown> = {}
  if (map) defines.USE_PLANET_MAP = ''
  if (shadowed) {
    defines.USE_RING_SHADOW = ''
    defines.MAX_RING_BANDS = MAX_RING_BANDS
  }
  if (ringMap) defines.USE_RING_MAP = ''
  return new THREE.ShaderMaterial({
    vertexShader: planetVertex,
    fragmentShader: planetFragment,
    defines,
    uniforms: {
      uSunDir: sunDir,
      uColor: { value: new THREE.Color() },
      uAlbedo: { value: 1 },
      uSunIntensity: { value: SUNLIGHT_INTENSITY },
      uAmbient: { value: AMBIENT },
      uMinnaert: { value: 1 },
      uMap: { value: map },
      uRingMap: { value: ringMap },
      uRingInner: { value: 0 },
      uRingOuter: { value: 0 },
      uRingOpacity: { value: 1 },
      ...bandUniforms(),
    },
  })
}
