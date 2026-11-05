import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { advance, flushGlobalEffects, useFrame, useStore as useRootStore } from '@react-three/fiber'
import { createIdleSchedule, cameraMoving, idleFrameloop, idleTick, isIdle, parseIdleRate, type IdleRateConfig } from '../idle-rate'
import { opening } from '../opening'
import { isLowQuality } from '../quality'
import { useStore } from '../store'

declare global {
  interface Window {
    /** The idle cap's driver, when the URL has ?idlehz=auto on the low tier (tides-0oi.31). */
    __idleRate?: {
      config: IdleRateConfig
      /** Turns the cap on or off (the driver keeps running: off draws every tick). */
      setOn: (on: boolean) => void
      /** Stops drawing altogether (the harness's pause), or starts again. */
      hold: (held: boolean) => void
      draws: number
      skips: number
      /** What last counted as activity: an event type, a store key, or 'camera'. */
      lastActivity: string
    }
  }
}

const config = parseIdleRate(typeof window === 'undefined' ? '' : window.location.search)

/** The root Canvas's frameloop for this page: 'never' when IdleRate drives it. */
export function rootFrameloop(): 'always' | 'never' {
  return idleFrameloop(config, isLowQuality())
}

// Module state, shared by the driver, the camera watch and the paced dpr.
let activityAt = -Infinity
let capHeld = false

function markActivity(what: string) {
  activityAt = performance.now()
  if (window.__idleRate) window.__idleRate.lastActivity = what
}

/** Whether the idle cap holds this frame: the paced dpr controller pauses meanwhile (paced-dpr.ts). */
export function idleCapHeld(): boolean {
  return capHeld
}

const ACTIVITY_EVENTS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'wheel',
  'keydown',
  'keyup',
  'touchstart',
  'touchmove',
  'touchend',
  'resize',
  'visibilitychange',
] as const

/**
 * Drives the root Canvas when its frameloop is 'never' (rootFrameloop): one
 * rAF loop that runs R3F's frame (global effects, every useFrame and draw,
 * global after-effects) each tick, except idle ticks between IDLE_HZ draws,
 * which do nothing (idle-rate.ts). clock.elapsedTime is seconds since the
 * driver started, as R3F's own loop counts from the root's start. Mount once
 * in the root Canvas, outside the Views.
 */
export function IdleRate({ sceneReady }: { sceneReady: boolean }): null {
  const rootStore = useRootStore()
  const ready = useRef(sceneReady)
  ready.current = sceneReady
  useEffect(() => {
    const get = rootStore.getState
    if (!config || get().frameloop !== 'never') return
    // advance() sets the time; a running clock would add its own (R3F's
    // update calls getDelta, which with autoStart restarts a stopped clock).
    const { clock } = get()
    clock.autoStart = false
    clock.stop()
    const periodMs = 1000 / config.hz
    const schedule = createIdleSchedule()
    let on = true
    let held = false
    let start: number | null = null
    const debug = (window.__idleRate = {
      config,
      setOn: (next: boolean) => void (on = next),
      hold: (next: boolean) => void (held = next),
      draws: 0,
      skips: 0,
      lastActivity: '',
    })
    const onActivity = (event: Event) => markActivity(event.type)
    for (const type of ACTIVITY_EVENTS) {
      const target = type === 'visibilitychange' ? document : window
      target.addEventListener(type, onActivity, { passive: true, capture: true })
    }
    // Any store change but the clock's own tick.
    const unsubscribeStore = useStore.subscribe((state, previous) => {
      for (const key in state) {
        if (key !== 'timestamp' && state[key as keyof typeof state] !== previous[key as keyof typeof previous]) {
          markActivity(key)
          return
        }
      }
    })
    // The canvas resizing (layout, rotation): R3F's setSize clears it, so the next tick must draw.
    const unsubscribeSize = rootStore.subscribe((state, previous) => {
      if (state.size !== previous.size || state.viewport.dpr !== previous.viewport.dpr) markActivity('size')
    })

    let frame = requestAnimationFrame(tick)
    function tick(ts: number) {
      frame = requestAnimationFrame(tick)
      if (held) return
      const { timeScale, jumpDate, demo, shipMode } = useStore.getState()
      const idle =
        on &&
        isIdle({
          now: ts,
          activityAt,
          timeScale,
          jumping: jumpDate !== null,
          demo: demo !== null,
          ship: shipMode,
          sceneReady: ready.current,
          openingDone: opening.done,
        })
      capHeld = idle
      if (!idleTick(schedule, ts, idle, periodMs)) {
        debug.skips++
        return
      }
      debug.draws++
      start ??= ts
      flushGlobalEffects('before', ts)
      advance((ts - start) / 1000, false)
      flushGlobalEffects('after', ts)
    }
    return () => {
      cancelAnimationFrame(frame)
      for (const type of ACTIVITY_EVENTS) {
        const target = type === 'visibilitychange' ? document : window
        target.removeEventListener(type, onActivity, { capture: true })
      }
      unsubscribeStore()
      unsubscribeSize()
      capHeld = false
      if (window.__idleRate === debug) window.__idleRate = undefined
    }
  }, [rootStore])
  return null
}

const lastQuaternion = new THREE.Quaternion()
const offset = new THREE.Vector3()
const lastOffset = new THREE.Vector3()

/**
 * Marks the main View's camera moving as activity (an ease, the controls'
 * damping, a framing move: none of them an input or a store change). Turning
 * with Earth's spin, as close zoom does, stays under the line. Mount in the
 * main View only, and only with the cap on.
 */
export function IdleCameraWatch(): null {
  const last = useRef<number | null>(null)
  useFrame((state) => {
    if (!config) return
    const { camera, controls } = state
    const now = performance.now()
    const target = (controls as { target?: THREE.Vector3 } | null)?.target
    if (target) offset.subVectors(camera.position, target)
    else offset.copy(camera.position)
    if (last.current !== null) {
      const distance = Math.max(offset.length(), 1e-9)
      const moveShare = offset.distanceTo(lastOffset) / distance
      const turn = lastQuaternion.angleTo(camera.quaternion)
      if (cameraMoving(turn, moveShare, now - last.current)) markActivity('camera')
    }
    last.current = now
    lastOffset.copy(offset)
    lastQuaternion.copy(camera.quaternion)
  })
  return null
}
