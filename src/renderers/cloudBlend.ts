// Cross-fades the real-weather cloud keyframes on the GPU (tides-kzj.4.2). The
// two frames that bracket the sim time (../cloud-frames.ts, pickBlend) are
// mixed by how far it has got from one to the other, so the clouds evolve as
// playback runs. When the pair changes in a way that isn't the next step along
// (a frame arrives late, a jump, a hold refresh, the first output) the last
// output is frozen and faded out over FADE_MS instead of cut. The result is
// a texture laid out like a cloud build's (R height, G alpha, B height
// confidence) for the cloud layer (./cloudShaders.ts), with the typed tops
// beside it (below).
//
// The frames' cloud-type grids (tides-tvr.4.1, ../cloud-types.ts) are blended
// the same way in a second, tiny pass of their own, so the output also has a
// type grid that keeps step with the clouds. A frame without one (the static
// clouds, a frame the cover grid didn't type) counts as confidence 0. That
// pass runs first, so that the main pass can write, into a second texture
// beside its output, each typed column's top and lift (tides-tvr.4.3,
// tides-tvr.4.9, ./cloudTypeGlsl.ts CLOUD_TYPED_TOP_GLSL), for the typed
// march to read where it reads the map.
//
// The frames' precipitation grids (tides-bl3.1, ../cloud-precip.ts) take a
// third pass with the type pass's own material, as they are laid out alike
// (premultiplied by A): a frame without one counts as A 0, no data.
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { OUT_H, OUT_W, smoothstep } from '../real-clouds'
import { TYPE_H, TYPE_W } from '../cloud-types'
import { CLOUD_TYPED_TOP_GLSL } from './cloudTypeGlsl'

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
// The tops (the second output) come from the blended type grid (uTypes, this
// output's own, drawn first) and the blended texel, whose B is already the
// trust the march takes (B times whether the output is measured): B is 0
// wherever no input measured heights. The frozen output's tops are never
// read: they are worked out afresh from the blend.
const fragmentShader = /* glsl */ `
layout(location = 0) out highp vec4 cloudMap;
layout(location = 1) out highp vec4 cloudTops;
uniform sampler2D uPrev;
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uTypes;
uniform float uPrevGeo;
uniform float uAGeo;
uniform float uBGeo;
uniform float uMix;
uniform float uFade;
varying vec2 vUv;
${CLOUD_TYPED_TOP_GLSL}

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
  vec3 c = blendCloud(cloudTexel(uPrev, uPrevGeo), frames, uFade);
  cloudMap = vec4(c, 1.0);
  cloudTops = cloudTypedTops(textureLod(uTypes, vUv, 0.0), c);
}
`

// The type grids, texel for texel (inputs and output are all TYPE_W x
// TYPE_H, or the neutral 1x1). The shares are premultiplied by confidence
// (../cloud-types.ts, tides-tvr.4.4), so mixed as they are they are weighted
// by it, as the heights are by trust above: a frame without types lowers the
// confidence without pulling the shares towards nothing.
export const TYPE_FRAGMENT_SHADER = /* glsl */ `
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
  return textureLod(t, vUv, 0.0) * typed;
}

void main() {
  vec4 frames = mix(typeTexel(uA, uATyped), typeTexel(uB, uBTyped), uMix);
  gl_FragColor = mix(typeTexel(uPrev, uPrevTyped), frames, uFade);
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

/** A frame's precipitation grid (realCloudTextures.ts keeps it in
 * userData.precip), or null without one. */
export function precipOf(texture: THREE.Texture): THREE.Texture | null {
  return (texture.userData.precip as THREE.Texture | null | undefined) ?? null
}

/** A frame's precipitation grid's bytes (../cloud-precip.ts, for
 * precipFromFrames on the main thread), or null without one; the static
 * clouds have none. */
export function precipBytesOf(texture: THREE.Texture | 'static'): Uint8Array | null {
  if (texture === 'static') return null
  return ((texture.userData.precip as THREE.DataTexture | null | undefined)?.image.data as Uint8Array | undefined) ?? null
}

/**
 * What an output carries: measured heights where any of its inputs did, and
 * types and precipitation likewise; the frozen output it fades from counts
 * until the fade ends, when the pass drops it.
 */
export function outputFlags(
  a: { geo: boolean; typed: boolean; precip: boolean },
  b: { geo: boolean; typed: boolean; precip: boolean },
  prev: { measured: boolean; typed: boolean; precip: boolean },
  fade: number
): { measured: boolean; typed: boolean; precip: boolean } {
  return {
    measured: a.geo || b.geo || (fade < 1 && prev.measured),
    typed: a.typed || b.typed || (fade < 1 && prev.typed),
    precip: a.precip || b.precip || (fade < 1 && prev.precip),
  }
}

interface Output {
  /** The blended map (textures[0]) and its typed tops (textures[1]). */
  target: THREE.WebGLRenderTarget
  /** The blended type grid, TYPE_W x TYPE_H. */
  types: THREE.WebGLRenderTarget
  /** Whether any of its inputs carried measured heights. */
  measured: boolean
  /** Whether any of its inputs carried a type grid. */
  typed: boolean
  /** The blended precipitation grid, TYPE_W x TYPE_H. */
  precip: THREE.WebGLRenderTarget
  /** Whether any of its inputs carried a precipitation grid. */
  hasPrecip: boolean
}

/** A blended type or precipitation grid. */
function createGridTarget(): THREE.WebGLRenderTarget {
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
  // render, which the cloud layer's LOD sampling needs. Two attachments
  // alike: the map, and its tops, which the march reads with the map's own
  // coordinates and mip.
  const target = new THREE.WebGLRenderTarget(OUT_W, OUT_H, {
    count: 2,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.NoColorSpace,
  })
  return {
    target,
    types: createGridTarget(),
    measured: false,
    typed: false,
    precip: createGridTarget(),
    hasPrecip: false,
  }
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
    precip: THREE.Texture
    hasPrecip: boolean
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
        uTypes: { value: null },
        uPrevGeo: { value: 0 },
        uAGeo: { value: 0 },
        uBGeo: { value: 0 },
        uMix: { value: 0 },
        uFade: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      glslVersion: THREE.GLSL3,
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
      fragmentShader: TYPE_FRAGMENT_SHADER,
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
          precip: frozen.precip.texture,
          hasPrecip: frozen.hasPrecip,
        }
        current = 1 - current
      } else {
        prev = {
          texture: staticTexture,
          types: neutralTypeTexture(),
          geo: false,
          measured: false,
          typed: false,
          precip: neutralTypeTexture(),
          hasPrecip: false,
        }
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
    u.uTypes.value = out.types.texture
    const aTypes = typesOf(pick.a)
    const bTypes = typesOf(pick.b)
    const aPrecip = precipOf(pick.a)
    const bPrecip = precipOf(pick.b)
    const flags = outputFlags(
      { geo: isGeo(pick.a), typed: aTypes !== null, precip: aPrecip !== null },
      { geo: isGeo(pick.b), typed: bTypes !== null, precip: bPrecip !== null },
      { measured: prev.measured, typed: prev.typed, precip: prev.hasPrecip },
      fade
    )
    out.measured = flags.measured
    out.typed = flags.typed
    out.hasPrecip = flags.precip

    // One pass of the grid material: the frozen output's grid, then each
    // frame's, a missing one as the neutral texel times 0.
    const t = typeMaterial.uniforms
    const gridQuad = typeQuad
    function drawGrid(
      target: THREE.WebGLRenderTarget,
      prevGrid: THREE.Texture,
      prevHas: boolean,
      aGrid: THREE.Texture | null,
      bGrid: THREE.Texture | null
    ) {
      t.uPrev.value = prevGrid
      t.uPrevTyped.value = prevHas ? 1 : 0
      t.uA.value = aGrid ?? neutralTypeTexture()
      t.uATyped.value = aGrid ? 1 : 0
      t.uB.value = bGrid ?? neutralTypeTexture()
      t.uBTyped.value = bGrid ? 1 : 0
      t.uMix.value = pick.mix
      t.uFade.value = fade
      gl.setRenderTarget(target)
      gridQuad.render(gl)
    }

    const restore = gl.getRenderTarget()
    drawGrid(out.types, prev.types, prev.typed, aTypes, bTypes)
    drawGrid(out.precip, prev.precip, prev.hasPrecip, aPrecip, bPrecip)
    gl.setRenderTarget(out.target)
    quad.render(gl)
    gl.setRenderTarget(restore)
    hasOutput = true
  }

  return {
    /**
     * Blends `pick` (null: keep the last output) and returns the texture to
     * show, or null before the first output. Idempotent within a frame for the
     * same wallMs, so every View can call it. typeTexture is the blended
     * cloud-type grid, which only counts where typed, and topsTexture its
     * typed columns, laid out like the map. precipTexture is the blended
     * precipitation grid (../cloud-precip.ts), and precip whether any input
     * had one.
     */
    update(
      gl: THREE.WebGLRenderer,
      pick: { a: THREE.Texture; b: THREE.Texture; mix: number } | null,
      staticTexture: THREE.Texture,
      wallMs: number
    ): {
      texture: THREE.Texture
      measured: boolean
      typed: boolean
      typeTexture: THREE.Texture
      topsTexture: THREE.Texture
      precipTexture: THREE.Texture
      precip: boolean
    } | null {
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
      return {
        texture: out.target.texture,
        measured: out.measured,
        typed: out.typed,
        typeTexture: out.types.texture,
        topsTexture: out.target.textures[1],
        precipTexture: out.precip.texture,
        precip: out.hasPrecip,
      }
    },
    /** Frees the GPU resources; the next update starts afresh. */
    release() {
      outputs?.forEach((o) => {
        o.target.dispose()
        o.types.dispose()
        o.precip.dispose()
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
