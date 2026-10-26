// What the default framebuffer's depth buffer actually stores (tides-zmw.9.4).
//
// Reversed-Z (tides-zmw.9.3) gains precision only on a float depth buffer: on
// a 24-bit fixed-point (unorm) one, a canyon-scale near plane (1e-6 u) would
// leave everything past ~16 u at one depth. WebGL can't say which it has:
// DEPTH_BITS reads 24 on Apple GPUs, which have no 24-bit depth format and
// store float32 (ANGLE Metal and Safari back D24S8 with Depth32Float), and the
// attachment's COMPONENT_TYPE describes the format the browser asked for, not
// the one it got. So this measures it: one tiny draw writes gl_FragDepth =
// 2^-k in a column per k and keeps the columns that still compare greater
// than 0. Unorm24 rounds 2^-25 to 0; float32 holds 2^-63.
//
// The probe draws through three (never raw GL state), so three's state cache
// stays right and gl.resetState() (which turns reversed-Z off) is never
// needed. It never sets the depth clear value: under reversed-Z three caches
// the flipped value, and a stray setClear(0) would leave the next setClear(1)
// skipped (three r180 DepthBuffer.setClear).

import * as THREE from 'three'

export type DepthKind = 'float' | 'unorm' | 'unknown'

export type DepthPrecision = {
  kind: DepthKind
  /** 32 for float; ~24 or ~16 for unorm; 0 when unknown. */
  bits: number
  /** The smallest 2^-k still stored above 0 (k counted up from DEPTH_PROBE_BASE); 0 when none. */
  maxPassK: number
  /** Probe cost in ms (shader compile, draw and the readback stall). */
  ms: number
}

/** The first column's exponent: 2^-8 is above 0 in every depth format. */
export const DEPTH_PROBE_BASE = 8
/** The last exponent probed: float32 holds 2^-63 easily (normals reach 2^-126). */
export const DEPTH_PROBE_TOP = 63
/** Device pixels per column. */
export const DEPTH_PROBE_COLUMN = 4
const PROBE_COLUMNS = DEPTH_PROBE_TOP - DEPTH_PROBE_BASE + 1
/** The strip's width in device pixels when the drawing buffer allows (224). */
export const DEPTH_PROBE_WIDTH = PROBE_COLUMNS * DEPTH_PROBE_COLUMN
const PROBE_HEIGHT = 4

/**
 * The verdict from one row of RGBA bytes read back from the probe strip
 * (`width` device pixels, column k − base at x = (k − base) · 4). A column
 * passes when its red is set. The passes must start at the first column and
 * stop for good: anything else (no pass at all, a pass after a miss) says the
 * probe didn't run as built, so the verdict is unknown, which counts as not
 * float.
 */
export function classifyDepthProbe(
  row: ArrayLike<number>,
  width: number,
  base = DEPTH_PROBE_BASE,
): Omit<DepthPrecision, 'ms'> {
  const columns = Math.min(PROBE_COLUMNS, Math.floor(width / DEPTH_PROBE_COLUMN))
  const passes: boolean[] = []
  for (let c = 0; c < columns; c++) {
    // The column's middle pixel, clear of any edge filtering.
    const x = c * DEPTH_PROBE_COLUMN + (DEPTH_PROBE_COLUMN >> 1)
    passes.push(row[4 * x] > 127)
  }
  const run = passes.indexOf(false) === -1 ? passes.length : passes.indexOf(false)
  const unknown = { kind: 'unknown' as const, bits: 0, maxPassK: 0 }
  if (run === 0) return unknown
  if (passes.slice(run).some(Boolean)) return unknown
  const maxPassK = base + run - 1
  if (maxPassK >= 32) return { kind: 'float', bits: 32, maxPassK }
  // A narrow canvas can stop the columns before the format does: the last
  // column passing says only "at least this precise".
  if (run === columns) return { ...unknown, maxPassK }
  // Unorm-n rounds 2^-k to 0 from k = n + 1 (k = n where the driver truncates).
  if (maxPassK >= 20) return { kind: 'unorm', bits: 24, maxPassK }
  if (maxPassK >= 12) return { kind: 'unorm', bits: 16, maxPassK }
  return { ...unknown, maxPassK }
}

/**
 * The material depthFunc that makes GL test with `func`: under reversed-Z
 * three swaps each function for its mirror before it reaches GL (Less →
 * Greater, Always → Never), so the probe asks for the mirror to get the
 * function itself.
 */
export function inEffect(func: THREE.DepthModes, reversed: boolean): THREE.DepthModes {
  if (!reversed) return func
  const mirror: Partial<Record<THREE.DepthModes, THREE.DepthModes>> = {
    [THREE.NeverDepth]: THREE.AlwaysDepth,
    [THREE.AlwaysDepth]: THREE.NeverDepth,
    [THREE.LessDepth]: THREE.GreaterDepth,
    [THREE.GreaterDepth]: THREE.LessDepth,
    [THREE.LessEqualDepth]: THREE.GreaterEqualDepth,
    [THREE.GreaterEqualDepth]: THREE.LessEqualDepth,
    [THREE.EqualDepth]: THREE.NotEqualDepth,
    [THREE.NotEqualDepth]: THREE.EqualDepth,
  }
  return mirror[func] ?? func
}

const VERTEX = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`

// Quad A: depth 0 everywhere in the strip (and black), whatever was there.
const FLOOR_FRAGMENT = /* glsl */ `
void main() {
  gl_FragDepth = 0.0;
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
}`

// Quad B: 2^-k per 4-px column, drawn (red) only where it's stored above 0.
const STEP_FRAGMENT = /* glsl */ `
uniform float uBase;
void main() {
  gl_FragDepth = exp2(-(uBase + floor(gl_FragCoord.x / ${DEPTH_PROBE_COLUMN.toFixed(1)})));
  gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
}`

/**
 * The probe's two materials: `floor` writes depth 0 (and black) with the
 * depth test in effect ALWAYS, `step` writes 2^-k (and red) in effect
 * GREATER. `reversed` is the depth buffer's live mode.
 */
export function createProbeMaterials(reversed: boolean) {
  const floor = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FLOOR_FRAGMENT,
    depthTest: true,
    depthWrite: true,
    depthFunc: inEffect(THREE.AlwaysDepth, reversed),
    toneMapped: false,
  })
  const step = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: STEP_FRAGMENT,
    uniforms: { uBase: { value: DEPTH_PROBE_BASE } },
    depthTest: true,
    depthWrite: false,
    depthFunc: inEffect(THREE.GreaterDepth, reversed),
    toneMapped: false,
  })
  return { floor, step }
}

/** The slice of WebGLRenderer the probe uses (a fake one in tests). */
export type ProbeRenderer = Pick<
  THREE.WebGLRenderer,
  | 'render'
  | 'clear'
  | 'getContext'
  | 'getRenderTarget'
  | 'setRenderTarget'
  | 'getViewport'
  | 'setViewport'
  | 'getScissor'
  | 'setScissor'
  | 'getScissorTest'
  | 'setScissorTest'
  | 'getPixelRatio'
  | 'getDrawingBufferSize'
  | 'readRenderTargetPixels'
  | 'autoClear'
> & { state: { buffers: { depth: { getReversed(): boolean } } } }

/**
 * Probe what `target`'s depth buffer stores (null: the default framebuffer)
 * with two full-strip quads in the bottom-left corner, and read the strip
 * back. Restores the render target, autoClear, viewport and scissor; clears
 * the strip on the default framebuffer so it never reaches the screen; never
 * touches the depth clear value; disposes what it built.
 */
export function probeDepthPrecision(
  renderer: ProbeRenderer,
  target: THREE.WebGLRenderTarget | null = null,
): DepthPrecision {
  const start = performance.now()
  const reversed = renderer.state.buffers.depth.getReversed()
  const ratio = renderer.getPixelRatio()
  const buffer = renderer.getDrawingBufferSize(new THREE.Vector2())
  const width = target ? target.width : Math.min(DEPTH_PROBE_WIDTH, buffer.x)
  const height = target ? target.height : Math.min(PROBE_HEIGHT, buffer.y)

  const saved = {
    target: renderer.getRenderTarget(),
    autoClear: renderer.autoClear,
    viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()),
    scissorTest: renderer.getScissorTest(),
  }

  const geometry = new THREE.PlaneGeometry(2, 2)
  const { floor, step } = createProbeMaterials(reversed)
  const scene = new THREE.Scene()
  const quadA = new THREE.Mesh(geometry, floor)
  const quadB = new THREE.Mesh(geometry, step)
  for (const [i, quad] of [quadA, quadB].entries()) {
    quad.frustumCulled = false
    quad.renderOrder = i
    scene.add(quad)
  }
  // Never used for projection (the vertex shader ignores it), but three
  // updates the camera's projection under reversed-Z, so it must be a real one.
  const camera = new THREE.OrthographicCamera()

  const row = new Uint8Array(4 * Math.max(width, 1))
  try {
    renderer.autoClear = false
    renderer.setRenderTarget(target)
    renderer.setScissorTest(false)
    if (!target) renderer.setViewport(0, 0, width / ratio, height / ratio)
    renderer.render(scene, camera)
    if (target) {
      renderer.readRenderTargetPixels(target, 0, 0, width, 1, row)
    } else {
      const gl = renderer.getContext()
      gl.readPixels(0, 0, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, row)
      // Wipe the strip with the current clear values (the first frame's own).
      renderer.setScissor(0, 0, width / ratio, height / ratio)
      renderer.setScissorTest(true)
      renderer.clear(true, true, true)
    }
  } finally {
    // The canvas's viewport and scissor first, then the target, which applies
    // its own (or, for null, the canvas's) to GL.
    renderer.setViewport(saved.viewport)
    renderer.setScissor(saved.scissor)
    renderer.setScissorTest(saved.scissorTest)
    renderer.setRenderTarget(saved.target)
    renderer.autoClear = saved.autoClear
    geometry.dispose()
    floor.dispose()
    step.dispose()
  }
  return { ...classifyDepthProbe(row, width), ms: +(performance.now() - start).toFixed(2) }
}

/**
 * Render targets with known depth formats, probed under ?depth=info beside the
 * default framebuffer: D16 must come back unorm 16 and the D32F ones float,
 * which shows the probe can tell the two apart on this device (D24 and D24S8
 * come back float on Apple GPUs and SwiftShader, which back them with
 * float32). The last is the target a float-depth pass would use under 9.7's
 * stencil handover.
 */
export const DEPTH_RT_PROBES = [
  { name: 'D16', type: THREE.UnsignedShortType, stencil: false, samples: 0 },
  { name: 'D24', type: THREE.UnsignedIntType, stencil: false, samples: 0 },
  { name: 'D24S8', type: THREE.UnsignedInt248Type, stencil: true, samples: 0 },
  { name: 'D32F', type: THREE.FloatType, stencil: false, samples: 0 },
  { name: 'D32FS8', type: THREE.FloatType, stencil: true, samples: 0 },
  { name: 'D32FS8x4', type: THREE.FloatType, stencil: true, samples: 4 },
] as const

export type DepthRtProbe = { name: string } & (DepthPrecision | { error: string })

/** Probe each of DEPTH_RT_PROBES; a target that fails to build reports its error. */
export function probeDepthTargets(renderer: ProbeRenderer): DepthRtProbe[] {
  return DEPTH_RT_PROBES.map(({ name, type, stencil, samples }) => {
    const depthTexture = new THREE.DepthTexture(DEPTH_PROBE_WIDTH, PROBE_HEIGHT, type)
    depthTexture.format = stencil ? THREE.DepthStencilFormat : THREE.DepthFormat
    const target = new THREE.WebGLRenderTarget(DEPTH_PROBE_WIDTH, PROBE_HEIGHT, {
      depthBuffer: true,
      stencilBuffer: stencil,
      depthTexture,
      samples,
    })
    try {
      return { name, ...probeDepthPrecision(renderer, target) }
    } catch (error) {
      return { name, error: String(error) }
    } finally {
      target.dispose()
      depthTexture.dispose()
    }
  })
}

// --- the page's result, probed once at mount (DepthPrecisionProbe) ---

let precision: DepthPrecision | null = null
let report: DepthReport | null = null
const listeners = new Set<() => void>()

/** The default framebuffer's verdict; null until the probe has run. */
export function depthPrecision(): DepthPrecision | null {
  return precision
}

export function setDepthPrecision(next: DepthPrecision | null): void {
  precision = next
  for (const fn of listeners) fn()
}

/** ?depth=info's full readout; null unless asked for and probed. */
export function depthReport(): DepthReport | null {
  return report
}

export function setDepthReport(next: DepthReport | null): void {
  report = next
  for (const fn of listeners) fn()
}

/** For useSyncExternalStore. */
export function subscribeDepthPrecision(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Whether the ship can take the canyon-scale near floor (NEAR_MIN_REVERSED,
 * tides-zmw.9.8): reversed-Z is on and the depth buffer stores float. False
 * before the probe has run, and wherever it couldn't tell.
 */
export function reversedFloatDepth(
  gl: { capabilities: { reversedDepthBuffer: boolean } },
  result: DepthPrecision | null = precision,
): boolean {
  return gl.capabilities.reversedDepthBuffer && result?.kind === 'float'
}

/** "float (k>=63)" / "unorm 24 (k=24)" / "unknown", for the dev log. */
export function describeDepthPrecision(result: DepthPrecision | null): string {
  if (!result) return 'not probed'
  if (result.kind === 'float') return `float (k>=${result.maxPassK})`
  if (result.kind === 'unorm') return `unorm ${result.bits} (k=${result.maxPassK})`
  return `unknown (k=${result.maxPassK})`
}

// --- ?depth=info ---

/** ?depth=info in the URL shows the readout; anything else leaves it off. */
export function parseDepthInfo(search: string): boolean {
  return new URLSearchParams(search).get('depth') === 'info'
}

export const DEPTH_INFO = typeof location === 'undefined' ? false : parseDepthInfo(location.search)

export type DepthReport = {
  precision: DepthPrecision
  targets: DepthRtProbe[]
  reversed: boolean
  clipControl: boolean
  depthBits: number
  stencilBits: number
  /** The default framebuffer's depth COMPONENT_TYPE as WebGL reports it (not what's stored). */
  componentType: string
  antialias: boolean
  stencil: boolean
  renderer: string
  drawingBuffer: string
  pixelRatio: number
  userAgent: string
}

/** Everything ?depth=info shows, the probes included. */
export function collectDepthReport(renderer: THREE.WebGLRenderer, result: DepthPrecision): DepthReport {
  const gl = renderer.getContext() as WebGL2RenderingContext
  const debug = gl.getExtension('WEBGL_debug_renderer_info')
  const attributes = gl.getContextAttributes()
  // Ask about the default framebuffer, bound through three so its cache stays right.
  const saved = renderer.getRenderTarget()
  renderer.setRenderTarget(null)
  let componentType = '?'
  try {
    const type = gl.getFramebufferAttachmentParameter(
      gl.FRAMEBUFFER,
      gl.DEPTH,
      gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE,
    ) as number
    componentType =
      type === gl.FLOAT ? 'FLOAT' : type === gl.UNSIGNED_NORMALIZED ? 'UNSIGNED_NORMALIZED' : String(type)
  } catch {
    // Older WebGL2 implementations refuse the query on the default framebuffer.
  }
  renderer.setRenderTarget(saved)
  const size = renderer.getDrawingBufferSize(new THREE.Vector2())
  return {
    precision: result,
    targets: probeDepthTargets(renderer),
    reversed: renderer.capabilities.reversedDepthBuffer,
    clipControl: !!gl.getExtension('EXT_clip_control'),
    depthBits: gl.getParameter(gl.DEPTH_BITS) as number,
    stencilBits: gl.getParameter(gl.STENCIL_BITS) as number,
    componentType,
    antialias: !!attributes?.antialias,
    stencil: !!attributes?.stencil,
    renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
    drawingBuffer: `${size.x}x${size.y}`,
    pixelRatio: renderer.getPixelRatio(),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  }
}
