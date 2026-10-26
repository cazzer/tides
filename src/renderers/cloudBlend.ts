// Cross-fades the real-weather cloud keyframes on the GPU (tides-kzj.4.2). The
// two frames that bracket the sim time (../cloud-frames.ts, pickBlend) are
// mixed by how far it has got from one to the other, so the clouds evolve as
// playback runs. When the pair changes in a way that isn't the next step along
// (a frame arrives late, a jump, a hold refresh, the first output) the last
// output is frozen and faded out over FADE_MS instead of cut. The result is
// one texture laid out like a cloud build's (R height, G alpha, B height
// confidence) for the cloud layer (./cloudShaders.ts).
//
// The frames' cloud-type grids (tides-tvr.4.1, ../cloud-types.ts) are blended
// the same way in a second, tiny pass of their own, so the output also has a
// type grid that keeps step with the clouds. A frame without one (the static
// clouds, a frame the cover grid didn't type) counts as confidence 0.
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { OUT_H, OUT_W, smoothstep } from '../real-clouds'
import { TYPE_H, TYPE_W } from '../cloud-types'

export const FADE_MS = 500
/** A bigger step in mix than this (between two frames) is a discontinuity. */
export const MAX_MIX_JUMP = 0.1

/** Inputs by identity: a and b name the textures, mix runs from a to b. */
export interface BlendInputs {
  a: string
  b: string
  mix: number
}

export interface BlendPassState extends BlendInputs {
  /** Wall-clock ms the current fade from the frozen output started. */
  fadeStart: number
  /** What the last pass drew, quantised to what 8 bits can show. */
  drawn: string
}

/**
 * Whether the blend needs drawing again. swap freezes the last output and
 * starts a fade from it; fade is how far that has got (0..1). A pass is
 * skipped when nothing would change in 8 bits, so the Views after the first in
 * a frame get the texture for free.
 */
export function planBlendPass(
  prev: BlendPassState | null,
  next: BlendInputs,
  wallMs: number
): { state: BlendPassState; pass: { swap: boolean; fade: number } | null } {
  const continuous =
    prev !== null &&
    ((next.a === prev.a && next.b === prev.b && Math.abs(next.mix - prev.mix) <= MAX_MIX_JUMP) ||
      // On to the next pair: both ends look like the frame they share.
      (next.a === prev.b && prev.mix >= 1 - MAX_MIX_JUMP && next.mix <= MAX_MIX_JUMP))
  const fadeStart = continuous ? prev.fadeStart : wallMs
  const fade = smoothstep(0, 1, (wallMs - fadeStart) / FADE_MS)
  // fade >= 1 too: 8 bits round to the end of the fade a little early, and
  // the last pass is what drops the frozen output's measured heights.
  const drawn = `${next.a}|${next.b}|${Math.round(next.mix * 255)}|${Math.round(fade * 255)}|${fade >= 1}`
  const state = { ...next, fadeStart, drawn }
  if (continuous && drawn === prev.drawn) return { state, pass: null }
  return { state, pass: { swap: !continuous, fade } }
}

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// Inputs are sampled at their full resolution (the static clouds are 2048 px
// wide, the builds and the output 2560). Only geostationary builds carry
// heights; elsewhere R and B are zeroed so the cloud layer uses its defaults.
const fragmentShader = /* glsl */ `
uniform sampler2D uPrev;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uPrevGeo;
uniform float uAGeo;
uniform float uBGeo;
uniform float uMix;
uniform float uFade;
varying vec2 vUv;

vec3 cloudTexel(sampler2D t, float geo) {
  vec3 c = textureLod(t, vUv, 0.0).rgb;
  return vec3(c.r * geo, c.g, c.b * geo);
}

// Height weighted by trust, so a frame without measured tops doesn't pull the
// other's down.
vec3 blendCloud(vec3 x, vec3 y, float t) {
  float b = mix(x.b, y.b, t);
  float r = b > 0.0 ? ((1.0 - t) * x.b * x.r + t * y.b * y.r) / b : 0.0;
  return vec3(r, mix(x.g, y.g, t), b);
}

void main() {
  vec3 frames = blendCloud(cloudTexel(uA, uAGeo), cloudTexel(uB, uBGeo), uMix);
  gl_FragColor = vec4(blendCloud(cloudTexel(uPrev, uPrevGeo), frames, uFade), 1.0);
}
`

// The type grids, texel for texel (inputs and output are all TYPE_W x
// TYPE_H, or the neutral 1x1). The shares are weighted by confidence, as the
// heights are by trust above, so a frame without types lowers the confidence
// without pulling the shares towards nothing.
const typeFragmentShader = /* glsl */ `
uniform sampler2D uPrev;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uPrevTyped;
uniform float uATyped;
uniform float uBTyped;
uniform float uMix;
uniform float uFade;
varying vec2 vUv;

vec4 typeTexel(sampler2D t, float typed) {
  vec4 c = textureLod(t, vUv, 0.0);
  return vec4(c.rgb, c.a * typed);
}

vec4 blendTypes(vec4 x, vec4 y, float t) {
  float a = mix(x.a, y.a, t);
  vec3 rgb = a > 0.0 ? ((1.0 - t) * x.a * x.rgb + t * y.a * y.rgb) / a : vec3(0.0);
  return vec4(rgb, a);
}

void main() {
  vec4 frames = blendTypes(typeTexel(uA, uATyped), typeTexel(uB, uBTyped), uMix);
  gl_FragColor = blendTypes(typeTexel(uPrev, uPrevTyped), frames, uFade);
}
`

let neutral: THREE.DataTexture | null = null

/** The type grid of a frame without one: a single texel of confidence 0.
 * Shared and never freed (4 bytes). */
export function neutralTypeTexture(): THREE.DataTexture {
  if (!neutral) {
    neutral = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
    neutral.colorSpace = THREE.NoColorSpace
    neutral.needsUpdate = true
  }
  return neutral
}

/** A frame's type grid (realCloudTextures.ts keeps it in userData.types), or
 * null without one. */
export function typesOf(texture: THREE.Texture): THREE.Texture | null {
  return (texture.userData.types as THREE.Texture | null | undefined) ?? null
}

/**
 * What an output carries: measured heights where any of its inputs did, and
 * types likewise; the frozen output it fades from counts until the fade
 * ends, when the pass drops it.
 */
export function outputFlags(
  a: { geo: boolean; typed: boolean },
  b: { geo: boolean; typed: boolean },
  prev: { measured: boolean; typed: boolean },
  fade: number
): { measured: boolean; typed: boolean } {
  return {
    measured: a.geo || b.geo || (fade < 1 && prev.measured),
    typed: a.typed || b.typed || (fade < 1 && prev.typed),
  }
}

interface Output {
  target: THREE.WebGLRenderTarget
  /** The blended type grid, TYPE_W x TYPE_H. */
  types: THREE.WebGLRenderTarget
  /** Whether any of its inputs carried measured heights. */
  measured: boolean
  /** Whether any of its inputs carried a type grid. */
  typed: boolean
}

function createTypeTarget(): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(TYPE_W, TYPE_H, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.NoColorSpace,
  })
  // Across 180° but not over the poles, like the frames' own grids.
  target.texture.wrapS = THREE.RepeatWrapping
  target.texture.wrapT = THREE.ClampToEdgeWrapping
  return target
}

function createTarget(): Output {
  // Rendering to a target writes linear values with no tone mapping, so the
  // bytes pass straight through; three regenerates the mipmaps after each
  // render, which the cloud layer's LOD sampling needs.
  const target = new THREE.WebGLRenderTarget(OUT_W, OUT_H, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.NoColorSpace,
  })
  return { target, types: createTypeTarget(), measured: false, typed: false }
}

const isGeo = (texture: THREE.Texture) => Boolean(texture.userData.geo)

export function createCloudBlender() {
  let state: BlendPassState | null = null
  // Ping-pong: one holds the output, the other the frozen output it fades from.
  let outputs: [Output, Output] | null = null
  let current = 0
  let hasOutput = false
  let prev: {
    texture: THREE.Texture
    types: THREE.Texture
    geo: boolean
    measured: boolean
    typed: boolean
  } | null = null
  let quad: FullScreenQuad | null = null
  let material: THREE.ShaderMaterial | null = null
  let typeQuad: FullScreenQuad | null = null
  let typeMaterial: THREE.ShaderMaterial | null = null

  function draw(
    gl: THREE.WebGLRenderer,
    pick: { a: THREE.Texture; b: THREE.Texture; mix: number },
    staticTexture: THREE.Texture,
    { swap, fade }: { swap: boolean; fade: number }
  ) {
    outputs ??= [createTarget(), createTarget()]
    material ??= new THREE.ShaderMaterial({
      uniforms: {
        uPrev: { value: null },
        uA: { value: null },
        uB: { value: null },
        uPrevGeo: { value: 0 },
        uAGeo: { value: 0 },
        uBGeo: { value: 0 },
        uMix: { value: 0 },
        uFade: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    })
    quad ??= new FullScreenQuad(material)
    typeMaterial ??= new THREE.ShaderMaterial({
      uniforms: {
        uPrev: { value: null },
        uA: { value: null },
        uB: { value: null },
        uPrevTyped: { value: 0 },
        uATyped: { value: 0 },
        uBTyped: { value: 0 },
        uMix: { value: 0 },
        uFade: { value: 0 },
      },
      vertexShader,
      fragmentShader: typeFragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    })
    typeQuad ??= new FullScreenQuad(typeMaterial)
    if (swap || !prev) {
      if (hasOutput) {
        const frozen = outputs[current]
        prev = {
          texture: frozen.target.texture,
          types: frozen.types.texture,
          geo: true,
          measured: frozen.measured,
          typed: frozen.typed,
        }
        current = 1 - current
      } else {
        prev = { texture: staticTexture, types: neutralTypeTexture(), geo: false, measured: false, typed: false }
      }
    }
    const out = outputs[current]
    const u = material.uniforms
    u.uPrev.value = prev.texture
    u.uPrevGeo.value = prev.geo ? 1 : 0
    u.uA.value = pick.a
    u.uAGeo.value = isGeo(pick.a) ? 1 : 0
    u.uB.value = pick.b
    u.uBGeo.value = isGeo(pick.b) ? 1 : 0
    u.uMix.value = pick.mix
    u.uFade.value = fade
    const aTypes = typesOf(pick.a)
    const bTypes = typesOf(pick.b)
    const t = typeMaterial.uniforms
    t.uPrev.value = prev.types
    t.uPrevTyped.value = prev.typed ? 1 : 0
    t.uA.value = aTypes ?? neutralTypeTexture()
    t.uATyped.value = aTypes ? 1 : 0
    t.uB.value = bTypes ?? neutralTypeTexture()
    t.uBTyped.value = bTypes ? 1 : 0
    t.uMix.value = pick.mix
    t.uFade.value = fade
    const flags = outputFlags(
      { geo: isGeo(pick.a), typed: aTypes !== null },
      { geo: isGeo(pick.b), typed: bTypes !== null },
      prev,
      fade
    )
    out.measured = flags.measured
    out.typed = flags.typed

    const restore = gl.getRenderTarget()
    gl.setRenderTarget(out.target)
    quad.render(gl)
    gl.setRenderTarget(out.types)
    typeQuad.render(gl)
    gl.setRenderTarget(restore)
    hasOutput = true
  }

  return {
    /**
     * Blends `pick` (null: keep the last output) and returns the texture to
     * show, or null before the first output. Idempotent within a frame for the
     * same wallMs, so every View can call it. typeTexture is the blended
     * cloud-type grid, which only counts where typed.
     */
    update(
      gl: THREE.WebGLRenderer,
      pick: { a: THREE.Texture; b: THREE.Texture; mix: number } | null,
      staticTexture: THREE.Texture,
      wallMs: number
    ): { texture: THREE.Texture; measured: boolean; typed: boolean; typeTexture: THREE.Texture } | null {
      if (pick) {
        const step = planBlendPass(
          state,
          { a: String(pick.a.id), b: String(pick.b.id), mix: pick.mix },
          wallMs
        )
        state = step.state
        if (step.pass) draw(gl, pick, staticTexture, step.pass)
      }
      if (!hasOutput || !outputs) return null
      const out = outputs[current]
      return { texture: out.target.texture, measured: out.measured, typed: out.typed, typeTexture: out.types.texture }
    },
    /** Frees the GPU resources; the next update starts afresh. */
    release() {
      outputs?.forEach((o) => {
        o.target.dispose()
        o.types.dispose()
      })
      material?.dispose()
      quad?.dispose()
      typeMaterial?.dispose()
      typeQuad?.dispose()
      outputs = null
      material = null
      quad = null
      typeMaterial = null
      typeQuad = null
      state = null
      prev = null
      current = 0
      hasOutput = false
    },
  }
}

export type CloudBlender = ReturnType<typeof createCloudBlender>
