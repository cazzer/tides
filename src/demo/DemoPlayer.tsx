import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Quaternion, Vector3, type Object3D } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { useStore } from '../store'
import { focusedRef } from '../main-view'
import { updateMainNearFar } from '../camera'
import { requestFocusSnap, takeFocusSnap } from '../main-camera-session'
import { prefersReducedMotion } from '../ship/reduced-motion'
import { findDemo } from './demos'
import { easeProgress, easedEye, poseDirection, type DemoFrame, type DemoPose } from './demo-script'
import { DEMO_MAX_DELTA } from './demo-travel'

/** How long the eye takes to reach a step's pose, in seconds. */
export const DEMO_EASE_SECONDS = 2.5

/**
 * After CameraProvider's frame (0), which moves the target with the focus,
 * and before the surface tiles' update (0.5) and drei's View render (1).
 */
export const DEMO_CAMERA_PRIORITY = 0.25

/**
 * After the ease the pose is held until CameraProvider's target has turned
 * onto the focus (within this share of the eye distance), or for at most
 * HOLD_LIMIT seconds; letting go sooner leaves the eye where the target was.
 */
const HOLD_SHARE = 0.01
const HOLD_LIMIT = 5

/**
 * A followed pose takes the target onto the focus outright once it is this
 * close (a share of the eye distance) on the ease's first frame, else once
 * the ease is done and CameraProvider has had its time to turn it there.
 */
const LOCK_SHARE = 0.05

type BodyRef = { current?: Object3D | null } | undefined

interface Ease {
  pose: DemoPose & { frame: DemoFrame }
  /** Eye minus target when the step began; null until the first frame. */
  from: Vector3 | null
  elapsed: number
  /** Held while the clock travels to the step; on arrival the eye goes on
   * to the step's own pose. */
  travel: boolean
  /** The target is kept on the focus each frame (a followed pose). */
  locked: boolean
}

function easeTo(pose: DemoPose, travel: boolean): Ease {
  return { pose: { ...pose, frame: pose.frame ?? 'sun' }, from: null, elapsed: 0, travel, locked: false }
}

const _focus = new Vector3()
const _sun = new Vector3()
const _earth = new Vector3()
const _goal = new Vector3()
const _earthTurn = new Quaternion()
const _bodies = { focus: _focus, sun: _sun, earth: _earth, earthTurn: _earthTurn }

/**
 * Eases the main view's eye to each demo step's pose, holds it until the
 * target has reached the focus, then lets go so the user can orbit. While the
 * clock travels, and for a pose against the stars or Earth, it follows the
 * focus instead until the step ends. A press or wheel in the view, or
 * focusing another body, lets go at once. Mount it in the main panel after
 * CameraProvider: it remounts with the panel (after a View from Earth step)
 * and eases from wherever the camera then is. The
 * camera write reads to tiltControls as a move from outside, which ends
 * CameraProvider's own framing ease.
 */
export function DemoPlayer() {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null
  const connected = useThree((s) => s.events.connected) as HTMLElement | undefined
  const canvas = useThree((s) => s.gl.domElement)
  const dom = connected || canvas
  const demo = useStore((s) => s.demo)
  const ease = useRef<Ease | null>(null)

  useEffect(() => {
    const step = demo && findDemo(demo.id)?.steps[demo.step]
    const pose = step?.camera
    const travelling = useStore.getState().demoTravel != null
    const held = travelling && step?.travel?.camera
    ease.current = !pose
      ? null
      : held
        ? easeTo({ ...held, focus: pose.focus }, true)
        : easeTo(pose, travelling)
    // A snap left unconsumed (the main view unmounted the next frame) must
    // not land on the user's restored view after the demo.
    if (!demo) takeFocusSnap()
  }, [demo])

  useEffect(() => () => void takeFocusSnap(), [])

  // The user taking hold of the view ends the ease; the demo's own bar
  // (outside the panels) does not.
  useEffect(() => {
    const letGo = (e: Event) => {
      const target = e.target as Element | null
      if (target?.closest?.('.panel') && !target.closest('button')) ease.current = null
    }
    dom.addEventListener('pointerdown', letGo)
    dom.addEventListener('wheel', letGo)
    return () => {
      dom.removeEventListener('pointerdown', letGo)
      dom.removeEventListener('wheel', letGo)
    }
  }, [dom])

  useFrame(({ gl }, delta) => {
    const current = ease.current
    if (!current || !controls) return
    const state = useStore.getState()
    // Left the demo: the restore runs this frame, before the effect clears
    // the ease, which would otherwise put the step's pose back over it.
    if (!state.demo || state.cameraFocus !== current.pose.focus) {
      ease.current = null
      return
    }
    const focus = focusedRef<BodyRef>(state, current.pose.focus)?.current
    const sun = (state.sun as BodyRef)?.current
    const earth = (state.earth as BodyRef)?.current
    if (!focus || !sun || !earth) return
    focus.getWorldPosition(_focus)
    sun.getWorldPosition(_sun)
    earth.getWorldPosition(_earth)
    earth.getWorldQuaternion(_earthTurn)

    // The travel has landed (or Next landed it): on to the step's own pose.
    // The eye was held on the same focus, so with the same direction this
    // is a straight push in or pull out.
    if (current.travel && !state.demoTravel) {
      const pose = findDemo(state.demo.id)?.steps[state.demo.step]?.camera
      if (!pose) {
        ease.current = null
        return
      }
      Object.assign(current, easeTo(pose, false), {
        from: camera.position.clone().sub(_focus),
        locked: current.locked,
      })
    }

    const target = controls.target
    const reduced = prefersReducedMotion()
    const first = !current.from
    if (!current.from) {
      current.from = camera.position.clone().sub(target)
      if (reduced) requestFocusSnap()
    }
    current.elapsed += Math.min(delta, DEMO_MAX_DELTA)
    const duration = reduced ? 0 : DEMO_EASE_SECONDS
    const t = easeProgress(current.elapsed, duration)

    poseDirection(current.pose, _bodies, _goal)
    easedEye(current.from, _goal, _focus, t, current.pose.distance, camera.position)

    // Followed, the focus can move far in a frame; CameraProvider's target
    // would trail it, so it is put on the focus outright, this frame here
    // and from the next by a snap.
    const follow = current.travel || current.pose.frame !== 'sun'
    if (follow && !current.locked) {
      const near = target.distanceTo(_focus) <= LOCK_SHARE * camera.position.distanceTo(_focus)
      current.locked = t >= 1 || (first && near)
    }
    if (follow && current.locked) {
      requestFocusSnap()
      target.copy(_focus)
    }
    camera.lookAt(target)
    updateMainNearFar(camera, controls, gl)

    // A followed pose holds until the step ends or the user takes hold.
    if (follow) return
    const arrived = target.distanceTo(_focus) <= HOLD_SHARE * current.pose.distance
    if (t >= 1 && (arrived || current.elapsed >= duration + HOLD_LIMIT) && !state.demoTravel) {
      ease.current = null
    }
  }, DEMO_CAMERA_PRIORITY)

  return null
}
