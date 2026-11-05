// The aurora curtains' slow noise, baked once a frame (tides-0oi.5): meander,
// fold, breaks and breaks2 (../shaders/aurora/curtain.glsl) depend only on the
// MLT angle, the hemisphere, one latitude-like coordinate and uTime, yet the
// march evaluated them at every step of every pixel. One table per renderer,
// shared by every View's aurora (they share the clock, so one bake a frame).
import * as THREE from 'three'
import curtainBakeFragment from '../shaders/aurora/curtainBake.frag'

/** The table's MLT angles (the seam wraps). */
export const CURTAIN_WIDTH = 512
/** The table's rows per hemisphere: 256 moved 0.2% of an oblique view's
 * pixels by more than 2/255 (the fold's 0.2° rows), 512 none to speak of. */
export const CURTAIN_ROWS = 512

export interface AuroraCurtain {
  /** CURTAIN_WIDTH x 2 CURTAIN_ROWS, RGBA = (meander, fold, breaks, breaks2) * 0.5 + 0.5. */
  texture: THREE.Texture
  /** Bakes the table for uTime `t`, unless it already holds it. */
  bake(t: number): void
}

const curtains = new WeakMap<THREE.WebGLRenderer, AuroraCurtain | null>()

/** Whether `renderer` can draw into a half-float target (as skyView.ts's
 * skyViewDrawable): without it the march keeps its own noise. */
function curtainDrawable(renderer: Pick<THREE.WebGLRenderer, 'extensions'>): boolean {
  return renderer.extensions.has('EXT_color_buffer_half_float') || renderer.extensions.has('EXT_color_buffer_float')
}

function curtainTarget(height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(CURTAIN_WIDTH, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    // Across the MLT seam the noise runs on (it is periodic in the angle).
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  })
}

/** A full-target pass of the bake shader. */
function bakePass(extraDefines: Record<string, number>, uniforms: Record<string, THREE.IUniform>): THREE.Scene {
  const material = new THREE.ShaderMaterial({
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: curtainBakeFragment,
    defines: { CURTAIN_WIDTH, CURTAIN_ROWS, ...extraDefines },
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  quad.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(quad)
  return scene
}

function createCurtain(renderer: THREE.WebGLRenderer): AuroraCurtain {
  const target = curtainTarget(2 * CURTAIN_ROWS)
  // meander and breaks, once per angle and hemisphere; the table copies them.
  const strip = curtainTarget(2)
  const time = { value: 0 }
  const stripPass = bakePass({ CURTAIN_STRIP: 1 }, { uTime: time })
  const tablePass = bakePass({}, { uTime: time, uStrip: { value: strip.texture } })
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  let lastT = Number.NaN
  // A lost context loses the table too: bake again once it is back (a frame
  // drawn in between bakes into nothing).
  const rebake = () => {
    lastT = Number.NaN
  }
  renderer.domElement.addEventListener('webglcontextlost', rebake)
  renderer.domElement.addEventListener('webglcontextrestored', rebake)

  return {
    texture: target.texture,
    bake(t) {
      if (t === lastT) return
      lastT = t
      time.value = t
      const previous = renderer.getRenderTarget()
      // Through render(), so a recorded frame (scripts/perf-audit) replays it.
      renderer.setRenderTarget(strip)
      renderer.render(stripPass, camera)
      renderer.setRenderTarget(target)
      renderer.render(tablePass, camera)
      renderer.setRenderTarget(previous)
    },
  }
}

/** The curtain table for `renderer`, set up on first use; null where it
 * can't be drawn. It lives as long as the renderer (4 MiB). Bake it
 * from an aurora mesh's onBeforeRender: only a frame that draws one pays. */
export function auroraCurtain(renderer: THREE.WebGLRenderer): AuroraCurtain | null {
  if (!curtains.has(renderer)) curtains.set(renderer, curtainDrawable(renderer) ? createCurtain(renderer) : null)
  return curtains.get(renderer)!
}
