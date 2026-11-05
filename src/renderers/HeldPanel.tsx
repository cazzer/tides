import { useEffect, useId, useRef, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import { useFrame, useThree, type RootState } from '@react-three/fiber'
import { useStore } from '../store'
import { viewViewport } from './glow/glow'
import { GLOW_COMPOSITE_PRIORITY } from './glow/GlowPass'
import {
  createPanelSchedule,
  dropPanel,
  panelDrawDue,
  panelPeriodMs,
  panelsPaced,
  parsePanelRate,
  type PanelRateConfig,
} from '../panel-rate'

declare global {
  interface Window {
    /** The panel rate's config, a switch and per-frame draw counts, when the URL has ?panelhz= (tides-0oi.18). */
    __panelRate?: {
      config: PanelRateConfig
      setPaced: (on: boolean) => void
      /** Panel draws and held fills since the last read (the harness resets them). */
      draws: number
      held: number
    }
  }
}

const config = parsePanelRate(typeof window === 'undefined' ? '' : window.location.search)
const schedule = createPanelSchedule()

// Whether the side panels are paced; a switch so the harness can render both
// ways in one page at the same tick.
let pacedOn = panelsPaced(config)
const listeners = new Set<() => void>()
function setPaced(on: boolean) {
  pacedOn = on
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('panelhz')) {
  window.__panelRate = { config, setPaced, draws: 0, held: 0 }
}

/** Whether side panels draw at the panel rate (?panelhz=, below 60). */
export function usePanelsPaced(): boolean {
  return useSyncExternalStore(subscribe, () => pacedOn)
}

/** After the glow's composite, when every View has drawn. */
const COPY_PRIORITY = GLOW_COMPOSITE_PRIORITY + 1

const copyOrigin = new THREE.Vector2()

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'wheel', 'touchmove'] as const

const fillVertex = /* glsl */ `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`
// The held frame's own bytes back: one texel a pixel, no filtering, no tone
// mapping, no colour space and no blending, so it is the frame it copied.
const fillFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D map;
  uniform vec2 origin;
  out vec4 color;
  void main() {
    color = texelFetch(map, ivec2(gl_FragCoord.xy) - ivec2(origin), 0);
  }
`

interface Held {
  texture: THREE.FramebufferTexture | null
  /** The canvas pixels the texture holds (x, y, width, height). */
  rect: THREE.Vector4
  /** The texture holds the panel's last draw. */
  valid: boolean
  /** This frame drew the panel and the copy at COPY_PRIORITY takes it. */
  copy: boolean
  pixels: THREE.Vector4
  quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  camera: THREE.OrthographicCamera
}

function createHeld(): Held {
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { map: { value: null }, origin: { value: new THREE.Vector2() } },
    vertexShader: fillVertex,
    fragmentShader: fillFragment,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  quad.frustumCulled = false
  return {
    texture: null,
    rect: new THREE.Vector4(),
    valid: false,
    copy: false,
    pixels: new THREE.Vector4(),
    quad,
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
  }
}

function disposeHeld(held: Held) {
  held.texture?.dispose()
  held.quad.geometry.dispose()
  held.quad.material.dispose()
}

// drei's View (web/View.js prepareSkissor / finishSkissor), verbatim, so a
// draw here is the same draw drei makes.
function prepareSkissor(
  state: RootState,
  { left, bottom, width, height }: { left: number; bottom: number; width: number; height: number }
) {
  const aspect = width / height
  const camera = state.camera as THREE.Camera & Partial<THREE.OrthographicCamera & THREE.PerspectiveCamera> & { manual?: boolean }
  if (camera.isOrthographicCamera) {
    if (!camera.manual) {
      if (camera.left !== width / -2 || camera.right !== width / 2 || camera.top !== height / 2 || camera.bottom !== height / -2) {
        Object.assign(camera, { left: width / -2, right: width / 2, top: height / 2, bottom: height / -2 })
        camera.updateProjectionMatrix!()
      }
    } else {
      camera.updateProjectionMatrix!()
    }
  } else if (camera.aspect !== aspect) {
    camera.aspect = aspect
    camera.updateProjectionMatrix!()
  }
  const autoClear = state.gl.autoClear
  state.gl.autoClear = false
  state.gl.setViewport(left, bottom, width, height)
  state.gl.setScissor(left, bottom, width, height)
  state.gl.setScissorTest(true)
  return autoClear
}

function finishSkissor(state: RootState, autoClear: boolean) {
  state.gl.setScissorTest(false)
  state.gl.autoClear = autoClear
}

/**
 * Draws the side panel it is mounted in (a drei View with visible={false})
 * at the panel rate (../panel-rate.ts, tides-0oi.18): on a draw frame
 * exactly as drei would, then the panel's canvas pixels are copied into a
 * texture once every View has drawn; on the frames between, that texture
 * fills the panel, byte for byte. Draws every frame until `ready`, and on
 * any frame the texture can't stand in (none yet, or the panel's pixels
 * moved or resized, as on a pixel ratio change).
 */
export function HeldPanel({ ready }: { ready: boolean }) {
  const id = useId()
  const track = useThree((s) => s.events.connected as HTMLElement | undefined)
  const held = useRef<Held | null>(null)
  const interactingAt = useRef<number | null>(null)

  useEffect(() => {
    const created = createHeld()
    held.current = created
    return () => {
      if (held.current === created) held.current = null
      disposeHeld(created)
      dropPanel(schedule, id)
    }
  }, [id])

  useEffect(() => {
    if (!track) return
    const touched = () => void (interactingAt.current = performance.now())
    for (const type of INPUT_EVENTS) track.addEventListener(type, touched, { passive: true })
    return () => {
      for (const type of INPUT_EVENTS) track.removeEventListener(type, touched)
    }
  }, [track])

  useFrame((state) => {
    const h = held.current
    if (!h || !track) return
    // The rect and canvas box drei's View reads (its canvasSize is the root's size).
    const viewport = viewViewport(state.previousRoot?.getState().size ?? state.size, track.getBoundingClientRect())
    if (!viewport) return
    const autoClear = prepareSkissor(state, viewport)
    state.gl.getCurrentViewport(h.pixels)
    const { timeScale, jumpDate, demo } = useStore.getState()
    const period = panelPeriodMs(
      { timeScale, jumping: jumpDate !== null, demo: demo !== null, interactingAt: interactingAt.current, now: performance.now() },
      config
    )
    const forced = !ready || !h.valid || !h.rect.equals(h.pixels)
    if (panelDrawDue(schedule, id, state.clock.elapsedTime, period, forced)) {
      state.gl.render(state.scene, state.camera)
      // At the full rate every frame draws, so nothing is kept to hold.
      h.copy = ready && period > 0
      h.valid = false
      if (window.__panelRate) window.__panelRate.draws++
    } else {
      h.quad.material.uniforms.map.value = h.texture
      h.quad.material.uniforms.origin.value.set(h.rect.x, h.rect.y)
      state.gl.render(h.quad, h.camera)
      if (window.__panelRate) window.__panelRate.held++
    }
    finishSkissor(state, autoClear)
  }, 1)

  useFrame((state) => {
    const h = held.current
    if (!h?.copy) return
    h.copy = false
    const { x, y, z: width, w: height } = h.pixels
    if (!h.texture || h.texture.image.width !== width || h.texture.image.height !== height) {
      h.texture?.dispose()
      h.texture = new THREE.FramebufferTexture(width, height)
    }
    state.gl.setRenderTarget(null)
    state.gl.copyFramebufferToTexture(h.texture, copyOrigin.set(x, y))
    h.rect.copy(h.pixels)
    h.valid = true
  }, COPY_PRIORITY)

  return null
}
