import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { advance, flushGlobalEffects, useFrame, useStore as useRootStore } from '@react-three/fiber'
import { cameraMoving, idleFrameloop, parseIdleRate, sizeActivity, storeActivity, type IdleRateConfig } from '../idle-rate'
import { createIdleDriver, dprSettledNow, idleCapHeld, lastActivityName, markActivity } from '../idle-driver'
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
      readonly draws: number
      readonly skips: number
      /** What last counted as activity: an event type, a store key, 'size' or 'camera'. */
      readonly lastActivity: string
      /** Whether the cap holds now, and whether the paced dpr has stopped climbing. */
      readonly capHeld: boolean
      readonly dprSettled: boolean
    }
  }
}

const config = parseIdleRate(typeof window === 'undefined' ? '' : window.location.search)

/**
 * The root Canvas's frameloop for this page, fixed at load (the tier and the
 * URL don't change without a reload): 'never' when IdleRate drives it. A
 * constant, so no re-render can flip it to 'always' and run two loops.
 */
export const ROOT_FRAMELOOP: 'always' | 'never' =
  typeof window === 'undefined' ? 'always' : idleFrameloop(config, isLowQuality())

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
 * Drives the root Canvas when its frameloop is 'never' (ROOT_FRAMELOOP): one
 * rAF loop that runs R3F's frame (global effects, every useFrame and draw,
 * global after-effects) each tick, except idle ticks between IDLE_HZ draws,
 * which do nothing (idle-driver.ts). clock.elapsedTime runs on from where it
 * was, as R3F's own loop counts from the root's start. Mount once in the root
 * Canvas, outside the Views.
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
    const driver = createIdleDriver({
      periodMs: 1000 / config.hz,
      view() {
        const { timeScale, jumpDate, demo, shipMode } = useStore.getState()
        return {
          timeScale,
          jumping: jumpDate !== null,
          demo: demo !== null,
          ship: shipMode,
          sceneReady: ready.current,
          openingDone: opening.done,
        }
      },
      elapsed: () => get().clock.elapsedTime,
      frame(ms, sec) {
        flushGlobalEffects('before', ms)
        advance(sec, false)
        flushGlobalEffects('after', ms)
      },
    })
    const debug = (window.__idleRate = {
      config,
      setOn: driver.setOn,
      hold: driver.hold,
      get draws() {
        return driver.draws
      },
      get skips() {
        return driver.skips
      },
      get lastActivity() {
        return lastActivityName()
      },
      get capHeld() {
        return idleCapHeld()
      },
      get dprSettled() {
        return dprSettledNow()
      },
    })
    const onActivity = (event: Event) => markActivity(event.type)
    for (const type of ACTIVITY_EVENTS) {
      const target = type === 'visibilitychange' ? document : window
      target.addEventListener(type, onActivity, { passive: true, capture: true })
    }
    const unsubscribeStore = useStore.subscribe((state, previous) => {
      const key = storeActivity(state, previous)
      if (key) markActivity(key)
    })
    const unsubscribeSize = rootStore.subscribe((state, previous) => {
      if (sizeActivity(state, previous)) markActivity('size')
    })

    let frame = requestAnimationFrame(tick)
    function tick(ts: number) {
      frame = requestAnimationFrame(tick)
      driver.tick(ts)
    }
    return () => {
      cancelAnimationFrame(frame)
      driver.stop()
      for (const type of ACTIVITY_EVENTS) {
        const target = type === 'visibilitychange' ? document : window
        target.removeEventListener(type, onActivity, { capture: true })
      }
      unsubscribeStore()
      unsubscribeSize()
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
 * with Earth's spin, as close zoom does, stays under the line. Timed by the
 * frame's own delta, as the motion is (a capped 33 ms step read over a
 * shorter wall-clock gap would look fast). Mount in the main View only.
 */
export function IdleCameraWatch(): null {
  const seen = useRef(false)
  useFrame((state, delta) => {
    if (!config) return
    const { camera, controls } = state
    const target = (controls as { target?: THREE.Vector3 } | null)?.target
    if (target) offset.subVectors(camera.position, target)
    else offset.copy(camera.position)
    if (seen.current) {
      const distance = Math.max(offset.length(), 1e-9)
      const moveShare = offset.distanceTo(lastOffset) / distance
      const turn = lastQuaternion.angleTo(camera.quaternion)
      if (cameraMoving(turn, moveShare, delta * 1000)) markActivity('camera')
    }
    seen.current = true
    lastOffset.copy(offset)
    lastQuaternion.copy(camera.quaternion)
  })
  return null
}
