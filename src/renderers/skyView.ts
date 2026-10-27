// The sky-view table (tides-34q.2): on the high tier, the sky from inside
// the haze is marched once a frame into a small table (sky-view.frag) for
// the eye's height and the Sun's elevation, and the atmosphere, the ground's
// haze (groundHaze.ts, the tiles' too) and the clouds' haze in front of a
// cloud (cloudShaders.ts) all read their colour from it (haze.glsl
// skyViewGlow()), so the sea meets the sky with no step. The low tier keeps
// the analytic sky (hazeSky()); so does every eye over the haze, where the
// limb's glow takes over.
import * as THREE from 'three'
import skyViewFragment from '../shaders/atmosphere/sky-view.frag'
import { ATMOSPHERE_SCALE_HEIGHT, ATMOSPHERE_SURFACE } from './earth-shells'

/** The table's size: azimuths from the Sun's (0 to 180 deg) by elevations. */
export const SKY_VIEW_WIDTH = 192
export const SKY_VIEW_HEIGHT = 128

/** The shared uniforms every includer of haze.glsl binds. Off (and empty)
 * until the atmosphere's table is drawn for the frame. */
export const SKY_VIEW_UNIFORMS = {
  uSkyView: { value: null as THREE.Texture | null },
  uSkyViewSize: { value: new THREE.Vector2(SKY_VIEW_WIDTH, SKY_VIEW_HEIGHT) },
  uSkyViewOn: { value: 0 },
}

/** Their declarations, for the includers' GLSL: once, as the ground's
 * program takes the clouds' head and the ground haze's both. */
export const SKY_VIEW_GLSL = /* glsl */ `
#ifndef SKY_VIEW_DECLARED
#define SKY_VIEW_DECLARED
uniform sampler2D uSkyView;
uniform vec2 uSkyViewSize;
uniform float uSkyViewOn;
#endif
`

const f = (x: number) => x.toFixed(6)

const VERTEX = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

export interface SkyView {
  /** Marches the table for an eye `eyeR` sea-level radii from the centre
   * under a Sun at sine of elevation `sunMu` there, and turns it on; or,
   * with `eyeR` null (no eye inside the haze), turns it off. */
  update(renderer: THREE.WebGLRenderer, eyeR: number | null, sunMu: number): void
  dispose(): void
}

export function createSkyView(): SkyView {
  const target = new THREE.WebGLRenderTarget(SKY_VIEW_WIDTH, SKY_VIEW_HEIGHT, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    generateMipmaps: false,
  })
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: skyViewFragment,
    defines: {
      SKY_VIEW_SURFACE: f(ATMOSPHERE_SURFACE),
      SKY_VIEW_SCALE_HEIGHT: f(ATMOSPHERE_SCALE_HEIGHT),
    },
    uniforms: {
      uEyeR: { value: 1 },
      uSunMu: { value: 1 },
      uSize: { value: new THREE.Vector2(SKY_VIEW_WIDTH, SKY_VIEW_HEIGHT) },
    },
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  quad.frustumCulled = false
  const camera = new THREE.OrthographicCamera()
  return {
    update(renderer, eyeR, sunMu) {
      // A half-float target needs a colour-buffer extension (WebGL2 without
      // it, a forced high tier, would draw the sky black): else analytic.
      if (eyeR == null || !(renderer.extensions.has('EXT_color_buffer_half_float') || renderer.extensions.has('EXT_color_buffer_float'))) {
        SKY_VIEW_UNIFORMS.uSkyViewOn.value = 0
        return
      }
      material.uniforms.uEyeR.value = eyeR
      material.uniforms.uSunMu.value = sunMu
      const previous = renderer.getRenderTarget()
      renderer.setRenderTarget(target)
      renderer.render(quad, camera)
      renderer.setRenderTarget(previous)
      SKY_VIEW_UNIFORMS.uSkyView.value = target.texture
      SKY_VIEW_UNIFORMS.uSkyViewOn.value = 1
    },
    dispose() {
      SKY_VIEW_UNIFORMS.uSkyViewOn.value = 0
      SKY_VIEW_UNIFORMS.uSkyView.value = null
      target.dispose()
      material.dispose()
      quad.geometry.dispose()
    },
  }
}
