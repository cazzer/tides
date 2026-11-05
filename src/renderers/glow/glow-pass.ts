// The glow's draws (tides-64u; ./glow.ts). Split in two around the View's own
// draw, as the spike found cheapest: prepare() before the View draws renders
// the sources into the glow target and blurs it, all off the canvas, so the
// canvas's (multisampled) drawable is begun once and not stored and reloaded
// mid-frame; composite() after the View drew adds the blur over its rect.
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import {
  GLOW_LAYER,
  GLOW_SCALE,
  glowCompositeRect,
  glowLevelSizes,
  glowReachPx,
  glowTargetSize,
  sphereScreenBox,
  viewViewport,
  type ScreenBox,
  type Size,
  type ViewViewport,
} from './glow'
import { glowSourcesOf, shownInWorld, type GlowSource } from './glowSources'

/**
 * The pass's savings, each on by default; the perf harness (scripts/perf-audit)
 * turns one off to render before and after in the same tick (tides-0oi.15).
 * scissor: the composite only over what the sources' glow can reach.
 * invalidateDepth: the glow target's depth is dropped once the sources have
 * drawn, so a tiled GPU never writes it back to memory.
 */
export const glowPassSwitches = { scissor: true, invalidateDepth: true }

/** gl.DEPTH_ATTACHMENT, as invalidateFramebuffer takes it. */
const DEPTH_ATTACHMENT = [0x8d00]

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
  prepare(
    gl: THREE.WebGLRenderer,
    scene: THREE.Object3D,
    camera: THREE.Camera,
    track: Element | null | undefined,
    canvas: { left: number; top: number; width: number; height: number }
  ): void
  /** After the View drew: the blur over the View's rect, if prepare made one. */
  composite(gl: THREE.WebGLRenderer): void
  dispose(): void
}

const clearColor = new THREE.Color()
const sphere = new THREE.Sphere()

/**
 * The View px the emitting sources cover (their meshes' bounding spheres on
 * GLOW_LAYER): 'all' when one can't be bounded (around the eye, or not a
 * perspective camera), null when none is in front. World matrices current.
 */
function sourcesBox(sources: readonly GlowSource[], camera: THREE.Camera, view: Size): ScreenBox | 'all' | null {
  if (!(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return 'all'
  const projection = camera.projectionMatrix.elements
  let box: ScreenBox | 'all' | null = null
  for (const { object, emits } of sources) {
    if (!emits || !shownInWorld(object) || box === 'all') continue
    object.traverseVisible((o) => {
      const mesh = o as THREE.Mesh
      if (box === 'all' || !mesh.isMesh || !mesh.layers.isEnabled(GLOW_LAYER)) return
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere()
      sphere.copy(mesh.geometry.boundingSphere!).applyMatrix4(mesh.matrixWorld)
      sphere.center.applyMatrix4(camera.matrixWorldInverse)
      const b = sphereScreenBox(sphere.center, sphere.radius, projection, view)
      if (!b) box = 'all'
      else if (!box) box = b
      else box = { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) }
    })
  }
  return box
}

export function createGlowPass(): GlowPass {
  let target: THREE.WebGLRenderTarget | null = null
  let levels: THREE.WebGLRenderTarget[] = []
  let ready: ViewViewport | null = null
  let reach: ViewViewport | null = null

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
    prepare(gl, scene, camera, track, canvas) {
      ready = null
      const sources = glowSourcesOf(scene)
      if (!sources.length || !track) return
      const viewport = viewViewport(canvas, track.getBoundingClientRect())
      if (!viewport) return
      // drei sets the aspect only as the View draws, after this: after a
      // resize, the first frame's glow would land at the old one.
      const perspective = camera as THREE.PerspectiveCamera
      const aspect = viewport.width / viewport.height
      if (perspective.isPerspectiveCamera && perspective.aspect !== aspect) {
        perspective.aspect = aspect
        perspective.updateProjectionMatrix()
      }
      let any = false
      for (const s of sources) if (shownInWorld(s.object)) any = true
      if (!any) return
      const ratio = gl.getPixelRatio()
      size({ width: Math.round(viewport.width * ratio), height: Math.round(viewport.height * ratio) })
      const glowTarget = target!
      // The View hasn't drawn yet this frame: bring the camera's and each
      // source's world matrices up to date, as its scene render would.
      camera.updateWorldMatrix(true, false)
      for (const { object } of sources) if (shownInWorld(object)) object.updateWorldMatrix(true, true)
      // Where the glow can land: the sources' box grown by the blur's reach
      // (glow-target px, so CSS px at this ratio). Nothing past it changes a
      // canvas pixel, and nothing at all when the box misses the View.
      reach = viewport
      if (glowPassSwitches.scissor) {
        const box = sourcesBox(sources, camera, viewport)
        reach = box && glowCompositeRect(box, glowReachPx(levels.length) / (GLOW_SCALE * ratio), viewport)
        if (!reach) return
      }

      const autoClear = gl.autoClear
      const alpha = gl.getClearAlpha()
      gl.getClearColor(clearColor)
      const mask = camera.layers.mask
      gl.autoClear = false
      gl.setRenderTarget(glowTarget)
      gl.setClearColor(0x000000, 0)
      gl.clear(true, true, false)
      camera.layers.set(GLOW_LAYER)
      for (const { object } of sources) {
        if (shownInWorld(object)) gl.render(object, camera)
      }
      camera.layers.mask = mask
      // Nothing reads the depth after the sources (the blur and composite
      // sample colour only, and the next frame clears it).
      if (glowPassSwitches.invalidateDepth) {
        const context = gl.getContext() as WebGL2RenderingContext
        context.invalidateFramebuffer(context.FRAMEBUFFER, DEPTH_ATTACHMENT)
      }
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
      const rect = reach
      ready = null
      if (!viewport || !rect) return
      const autoClear = gl.autoClear
      gl.autoClear = false
      gl.setRenderTarget(null)
      gl.setViewport(viewport.left, viewport.bottom, viewport.width, viewport.height)
      gl.setScissor(rect.left, rect.bottom, rect.width, rect.height)
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
