// The glow's draws (tides-64u; ./glow.ts). Split in two around the View's own
// draw, as the spike found cheapest: prepare() before the View draws renders
// the sources into the glow target and blurs it, all off the canvas, so the
// canvas's (multisampled) drawable is begun once and not stored and reloaded
// mid-frame; composite() after the View drew adds the blur over its rect.
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import {
  GLOW_LAYER,
  glowLevelSizes,
  glowTargetSize,
  viewViewport,
  type Size,
  type ViewViewport,
} from './glow'
import { glowSourcesOf, shownInWorld } from './glowSources'

/**
 * How much of each coarser level comes back up into the finer one: under 1
 * the wide levels weigh less, so the glow hugs its source and fades out
 * rather than spreading a flat haze.
 */
export const GLOW_SPREAD = 0.55

/** The glow's gain over the canvas (in the stand-ins' linear units). */
export const GLOW_STRENGTH = 1.6

/** [TUNE] The power the glow is raised to on its way onto the canvas (see
 * the composite). */
export const GLOW_DISPLAY_POWER = 0.8

/**
 * The finest blur level's total weight over a source: each level carries
 * the source's level of light, and each coarser one comes back up at
 * GLOW_SPREAD of the last, so the sum is a geometric series. Dividing by it
 * makes the blur a mean, equal to the source over a wide source's middle.
 */
export function glowBlurWeight(levels: number, spread = GLOW_SPREAD): number {
  let sum = 0
  for (let i = 0, w = 1; i < levels; i++, w *= spread) sum += w
  return Math.max(sum, 1)
}

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// Dual-filter (Kawase) down: the centre and four diagonal bilinear taps.
const downFragment = /* glsl */ `
  uniform sampler2D tSource;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec3 s = texture2D(tSource, vUv).rgb * 4.0;
    s += texture2D(tSource, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
    s += texture2D(tSource, vUv + uTexel * vec2(1.0, -1.0)).rgb;
    s += texture2D(tSource, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
    s += texture2D(tSource, vUv + uTexel * vec2(1.0, 1.0)).rgb;
    gl_FragColor = vec4(s * 0.125, 1.0);
  }
`

// Dual-filter up: an eight-tap tent, added (blending) onto the finer level,
// which still holds its own downsample.
const upFragment = /* glsl */ `
  uniform sampler2D tSource;
  uniform vec2 uTexel;
  uniform float uSpread;
  varying vec2 vUv;
  void main() {
    vec3 s = texture2D(tSource, vUv + uTexel * vec2(-2.0, 0.0)).rgb;
    s += texture2D(tSource, vUv + uTexel * vec2(2.0, 0.0)).rgb;
    s += texture2D(tSource, vUv + uTexel * vec2(0.0, -2.0)).rgb;
    s += texture2D(tSource, vUv + uTexel * vec2(0.0, 2.0)).rgb;
    s += texture2D(tSource, vUv + uTexel * vec2(-1.0, 1.0)).rgb * 2.0;
    s += texture2D(tSource, vUv + uTexel * vec2(1.0, 1.0)).rgb * 2.0;
    s += texture2D(tSource, vUv + uTexel * vec2(-1.0, -1.0)).rgb * 2.0;
    s += texture2D(tSource, vUv + uTexel * vec2(1.0, -1.0)).rgb * 2.0;
    gl_FragColor = vec4(s * (uSpread / 12.0), 1.0);
  }
`

// Over the canvas, which holds display values. Only the halo: the blur (as
// a weighted mean of its levels) less the sharp sources themselves, so a
// source's own pixels (the Sun's disc, a city) keep their look and the glow
// lies past their edges. Then a soft shoulder (never past 1) and a screen
// blend (below), which lifts the dark sky and leaves a white Sun white.
const compositeFragment = /* glsl */ `
  uniform sampler2D tGlow;
  uniform sampler2D tSharp;
  uniform float uStrength;
  uniform float uNorm;
  varying vec2 vUv;
  void main() {
    vec3 halo = texture2D(tGlow, vUv).rgb * uNorm - texture2D(tSharp, vUv).rgb;
    vec3 g = max(halo, vec3(0.0)) * uStrength;
    // Toward display values only part way: the full encoding (a 1/2.2
    // power) lifts the faint far blur of a city-lit night side into an
    // amber veil; none leaves the halo too faint to read.
    gl_FragColor = vec4(pow(1.0 - exp(-g), vec3(${GLOW_DISPLAY_POWER.toFixed(3)})), 1.0);
  }
`

function quadMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, extra: Partial<THREE.ShaderMaterialParameters> = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: quadVertex,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    ...extra,
  })
}

function levelTarget(size: Size): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(size.width, size.height, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
  })
}

export interface GlowPass {
  /** Before the View draws: the sources into the glow target, then the blur. */
  prepare(gl: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera, track: Element | null | undefined): void
  /** After the View drew: the blur over the View's rect, if prepare made one. */
  composite(gl: THREE.WebGLRenderer): void
  dispose(): void
}

const clearColor = new THREE.Color()

export function createGlowPass(): GlowPass {
  let target: THREE.WebGLRenderTarget | null = null
  let levels: THREE.WebGLRenderTarget[] = []
  let ready: ViewViewport | null = null

  const down = quadMaterial(downFragment, { tSource: { value: null }, uTexel: { value: new THREE.Vector2() } })
  const up = quadMaterial(
    upFragment,
    { tSource: { value: null }, uTexel: { value: new THREE.Vector2() }, uSpread: { value: GLOW_SPREAD } },
    { blending: THREE.AdditiveBlending, transparent: true }
  )
  const composite = quadMaterial(
    compositeFragment,
    { tGlow: { value: null }, tSharp: { value: null }, uStrength: { value: GLOW_STRENGTH }, uNorm: { value: 1 } },
    {
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneMinusDstColorFactor,
      blendDst: THREE.OneFactor,
    }
  )
  const quad = new FullScreenQuad(down)

  const size = (view: Size) => {
    const want = glowTargetSize(view)
    if (target && target.width === want.width && target.height === want.height) return
    target?.depthTexture?.dispose()
    target?.dispose()
    levels.forEach((l) => l.dispose())
    target = new THREE.WebGLRenderTarget(want.width, want.height, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    })
    // Float depth: reversed-Z (shaders/depth.glsl) keeps its precision from
    // the ship's metres out to the Sun only in a float buffer.
    target.depthTexture = new THREE.DepthTexture(want.width, want.height, THREE.FloatType)
    levels = glowLevelSizes(want).map(levelTarget)
  }

  const blur = (gl: THREE.WebGLRenderer, source: THREE.WebGLRenderTarget): THREE.Texture => {
    quad.material = down
    let from = source
    for (const level of levels) {
      down.uniforms.tSource.value = from.texture
      down.uniforms.uTexel.value.set(1 / from.width, 1 / from.height)
      gl.setRenderTarget(level)
      quad.render(gl)
      from = level
    }
    quad.material = up
    for (let i = levels.length - 1; i > 0; i--) {
      up.uniforms.tSource.value = levels[i].texture
      up.uniforms.uTexel.value.set(0.5 / levels[i].width, 0.5 / levels[i].height)
      gl.setRenderTarget(levels[i - 1])
      quad.render(gl)
    }
    return levels.length ? levels[0].texture : source.texture
  }

  return {
    prepare(gl, scene, camera, track) {
      ready = null
      const sources = glowSourcesOf(scene)
      if (!sources.length || !track) return
      const viewport = viewViewport(gl.domElement.getBoundingClientRect(), track.getBoundingClientRect())
      if (!viewport) return
      let any = false
      for (const s of sources) if (shownInWorld(s.object)) any = true
      if (!any) return
      const ratio = gl.getPixelRatio()
      size({ width: Math.round(viewport.width * ratio), height: Math.round(viewport.height * ratio) })
      const glowTarget = target!

      const autoClear = gl.autoClear
      const alpha = gl.getClearAlpha()
      gl.getClearColor(clearColor)
      const mask = camera.layers.mask
      gl.autoClear = false
      gl.setRenderTarget(glowTarget)
      gl.setClearColor(0x000000, 0)
      gl.clear(true, true, false)
      // The View hasn't drawn yet this frame: bring the camera's and each
      // source's world matrices up to date, as its scene render would.
      camera.updateWorldMatrix(true, false)
      camera.layers.set(GLOW_LAYER)
      for (const { object } of sources) {
        if (!shownInWorld(object)) continue
        object.parent?.updateWorldMatrix(true, false)
        gl.render(object, camera)
      }
      camera.layers.mask = mask
      const glow = blur(gl, glowTarget)
      gl.setRenderTarget(null)
      gl.setClearColor(clearColor, alpha)
      gl.autoClear = autoClear
      composite.uniforms.tGlow.value = glow
      composite.uniforms.tSharp.value = glowTarget.texture
      composite.uniforms.uNorm.value = 1 / glowBlurWeight(levels.length)
      ready = viewport
    },
    composite(gl) {
      const viewport = ready
      ready = null
      if (!viewport) return
      const autoClear = gl.autoClear
      gl.autoClear = false
      gl.setRenderTarget(null)
      gl.setViewport(viewport.left, viewport.bottom, viewport.width, viewport.height)
      gl.setScissor(viewport.left, viewport.bottom, viewport.width, viewport.height)
      gl.setScissorTest(true)
      quad.material = composite
      quad.render(gl)
      gl.setScissorTest(false)
      gl.autoClear = autoClear
    },
    dispose() {
      target?.depthTexture?.dispose()
      target?.dispose()
      levels.forEach((l) => l.dispose())
      target = null
      levels = []
      down.dispose()
      up.dispose()
      composite.dispose()
      quad.dispose()
    },
  }
}
