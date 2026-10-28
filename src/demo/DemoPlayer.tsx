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
import { easeProgress, eyeDirection, type DemoPose } from './demo-script'

/** How long the eye takes to reach a step's pose, in seconds. */
export const DEMO_EASE_SECONDS = 2.5

/**
 * After CameraProvider's frame (0), which moves the target with the focus,
 * and before the surface tiles' update (0.5) and drei's View render (1).
 */
export const DEMO_CAMERA_PRIORITY = 0.25

/** The longest frame the ease counts, so a stall doesn't skip it. */
const MAX_DELTA = 0.1

/**
 * After the ease the pose is held until CameraProvider's target has turned
 * onto the focus (within this share of the eye distance), or for at most
 * HOLD_LIMIT seconds; letting go sooner leaves the eye where the target was.
 */
const HOLD_SHARE = 0.01
const HOLD_LIMIT = 5

type BodyRef = { current?: Object3D | null } | undefined

interface Ease {
  pose: DemoPose
  /** Eye minus target when the step began; null until the first frame. */
  from: Vector3 | null
  elapsed: number
}

const _focus = new Vector3()
const _sun = new Vector3()
const _earth = new Vector3()
const _goal = new Vector3()
const _fromDir = new Vector3()
const _turn = new Quaternion()
const _partial = new Quaternion()

/**
 * Eases the main view's eye to each demo step's pose, holds it until the
 * target has reached the focus, then lets go so the user can orbit. A press
 * or wheel in the view, or focusing another body, lets go at once. Mount it
 * in the main panel after CameraProvider: it remounts with the panel (after a
 * View from Earth step) and eases from wherever the camera then is. The
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
    const pose = demo && findDemo(demo.id)?.steps[demo.step]?.camera
    ease.current = pose ? { pose, from: null, elapsed: 0 } : null
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

  useFrame((_, delta) => {
    const current = ease.current
    if (!current || !controls) return
    const state = useStore.getState()
    if (state.cameraFocus !== current.pose.focus) {
      ease.current = null
      return
    }
    const focus = focusedRef<BodyRef>(state, current.pose.focus)?.current
    const sun = (state.sun as BodyRef)?.current
    const earth = (state.earth as BodyRef)?.current
    if (!focus || !sun || !earth) return

    const target = controls.target
    const reduced = prefersReducedMotion()
    if (!current.from) {
      current.from = camera.position.clone().sub(target)
      if (reduced) requestFocusSnap()
    }
    current.elapsed += Math.min(delta, MAX_DELTA)
    const duration = reduced ? 0 : DEMO_EASE_SECONDS
    const t = easeProgress(current.elapsed, duration)

    focus.getWorldPosition(_focus)
    sun.getWorldPosition(_sun)
    earth.getWorldPosition(_earth)
    eyeDirection(_focus, _sun, _earth, current.pose.azimuth, current.pose.elevation, _goal)

    const fromDistance = current.from.length()
    _fromDir.copy(current.from).normalize()
    _turn.setFromUnitVectors(_fromDir, _goal)
    _partial.identity().slerp(_turn, t)
    const distance = fromDistance > 0
      ? Math.exp((1 - t) * Math.log(fromDistance) + t * Math.log(current.pose.distance))
      : current.pose.distance
    camera.position
      .copy(_fromDir.applyQuaternion(_partial))
      .multiplyScalar(distance)
      .add(target)
    camera.lookAt(target)
    updateMainNearFar(camera, controls)

    const arrived = target.distanceTo(_focus) <= HOLD_SHARE * current.pose.distance
    if (t >= 1 && (arrived || current.elapsed >= duration + HOLD_LIMIT)) ease.current = null
  }, DEMO_CAMERA_PRIORITY)

  return null
}
