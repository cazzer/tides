// The lightning's material (tides-ufyr.13, .13.1): each flash a patch of lit
// cloud on the deck's tangent plane (shaders/lightning), added over the
// cloud, read through the cloud layer's own map.
import * as THREE from 'three'
import { EARTH_RADIUS_KM } from '../cloud-layer'
import { CLEAR_FLOOR, MAX_FLASH_FRACTION, MIN_EDGE_PX, MIN_FLASH_PX, THICK_FLOOR } from '../lightning-patch'
import lightningVertex from '../shaders/lightning/vertex.glsl'
import lightningFragment from '../shaders/lightning/fragment.frag'

/** [TUNE] The glow's gain. */
export const LIGHTNING_GAIN = 1.5

/** The cloud layer's uniforms the flashes read (CloudLayer['uniforms']), shared, never copied. */
export interface LightningCloud {
  /** Its map, whether that is one channel (its grey in R), and its drift. */
  map: THREE.IUniform<THREE.Texture | null>
  red: THREE.IUniform<number>
  shift: THREE.IUniform<number>
}

/** The flashes' material over an Earth sphere of `radius` scene units. */
export function createLightningMaterial(radius: number, cloud: LightningCloud): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: lightningVertex,
    fragmentShader: lightningFragment,
    uniforms: {
      uTime: { value: 0 },
      uRadius: { value: radius },
      uKmToScene: { value: radius / EARTH_RADIUS_KM },
      uSun: { value: new THREE.Vector3(1, 0, 0) },
      uMinPx: { value: MIN_FLASH_PX },
      uViewportW: { value: 1 },
      uViewportH: { value: 1 },
      uMaxFrac: { value: MAX_FLASH_FRACTION },
      uMinEdgePx: { value: MIN_EDGE_PX },
      uGain: { value: LIGHTNING_GAIN },
      uCloudMap: cloud.map,
      uCloudMapRed: cloud.red,
      uCloudShift: cloud.shift,
      uClearFloor: { value: CLEAR_FLOOR },
      uThickFloor: { value: THICK_FLOOR },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // The patch lies in the deck's plane: either face may be toward the eye.
    side: THREE.DoubleSide,
    toneMapped: false,
  })
}
