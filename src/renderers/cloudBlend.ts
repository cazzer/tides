// Cross-fades the real-weather cloud keyframes on the GPU (tides-kzj.4.2). The
// two frames that bracket the sim time (../cloud-frames.ts, pickBlend) are
// mixed by how far it has got from one to the other, so the clouds evolve as
// playback runs. When the pair changes in a way that isn't the next step along
// (a frame arrives late, a jump, a hold refresh, the first output) the last
// output is frozen and faded out over FADE_MS instead of cut. The result is
// one texture laid out like a cloud build's (R height, G alpha, B height
// confidence) for the cloud layer (./cloudShaders.ts).
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { OUT_H, OUT_W, smoothstep } from '../real-clouds'

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
  const drawn = `${next.a}|${next.b}|${Math.round(next.mix * 255)}|${Math.round(fade * 255)}`
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

interface Output {
  target: THREE.WebGLRenderTarget
  /** Whether any of its inputs carried measured heights. */
  measured: boolean
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
  return { target, measured: false }
}

const isGeo = (texture: THREE.Texture) => Boolean(texture.userData.geo)

export function createCloudBlender() {
  let state: BlendPassState | null = null
  // Ping-pong: one holds the output, the other the frozen output it fades from.
  let outputs: [Output, Output] | null = null
  let current = 0
  let hasOutput = false
  let prev: { texture: THREE.Texture; geo: boolean; measured: boolean } | null = null
  let quad: FullScreenQuad | null = null
  let material: THREE.ShaderMaterial | null = null

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
    if (swap || !prev) {
      if (hasOutput) {
        const frozen = outputs[current]
        prev = { texture: frozen.target.texture, geo: true, measured: frozen.measured }
        current = 1 - current
      } else {
        prev = { texture: staticTexture, geo: false, measured: false }
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
    out.measured = isGeo(pick.a) || isGeo(pick.b) || (fade < 1 && prev.measured)

    const restore = gl.getRenderTarget()
    gl.setRenderTarget(out.target)
    quad.render(gl)
    gl.setRenderTarget(restore)
    hasOutput = true
  }

  return {
    /**
     * Blends `pick` (null: keep the last output) and returns the texture to
     * show, or null before the first output. Idempotent within a frame for the
     * same wallMs, so every View can call it.
     */
    update(
      gl: THREE.WebGLRenderer,
      pick: { a: THREE.Texture; b: THREE.Texture; mix: number } | null,
      staticTexture: THREE.Texture,
      wallMs: number
    ): { texture: THREE.Texture; measured: boolean } | null {
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
      return { texture: out.target.texture, measured: out.measured }
    },
    /** Frees the GPU resources; the next update starts afresh. */
    release() {
      outputs?.forEach((o) => o.target.dispose())
      material?.dispose()
      quad?.dispose()
      outputs = null
      material = null
      quad = null
      state = null
      prev = null
      current = 0
      hasOutput = false
    },
  }
}

export type CloudBlender = ReturnType<typeof createCloudBlender>
