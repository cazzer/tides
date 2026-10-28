import { useEffect, useRef } from 'react'
import { Spherical, Vector3, type EventDispatcher } from 'three'
import { MAIN_DISTANCE } from './main-view'

const DEG = Math.PI / 180
const Y = new Vector3(0, 1, 0)
const SETTLED = 1e-3

// Azimuth runs from the trailing tangent toward the outward radial, so the
// clock text (reading outward along the radial) runs left to right on screen.
// Distance is the main view's default eye distance.
export const CLOCK_VIEW = {
  azimuth: 20 * DEG,
  elevation: 40 * DEG,
  distance: MAIN_DISTANCE,
} as const
export const CLOCK_FRAMING_EASE = 0.05
// Earth sits off to the right of the clock: in a view narrower than this
// (width / height), a portrait phone's, the eye backs off until the view is
// as wide at the clock as here, or Earth ran off the edge (tides-3bc).
export const CLOCK_MIN_ASPECT = 0.8

export type ClockRide = { angle: number | null; ease: number; entryEase: number }

const offset = new Vector3()
const canonical = new Vector3()
const spherical = new Spherical()
const framed = new Spherical()

function wrapToPi(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI))
}

/** The eye's offset from the clock at `angle`, in a view of `aspect`. */
export function clockViewOffset(angle: number, out = new Vector3(), aspect = Infinity): Vector3 {
  const { azimuth, elevation, distance } = CLOCK_VIEW
  return out.setFromSphericalCoords(
    distance * Math.max(1, CLOCK_MIN_ASPECT / aspect),
    Math.PI / 2 - elevation,
    angle + azimuth
  )
}

export function leaveClock(ride: ClockRide): void {
  ride.angle = null
  ride.entryEase = CLOCK_FRAMING_EASE
}

/**
 * Whether the clock ride may move the eye this frame: not while the Earth
 * pivot's `tilt` eases out after leaving Earth focus (tides-oyd). tiltControls
 * takes any outside write to the camera as a new untilted pose and tilts it
 * again, so riding then would compound the tilt every frame and spin the
 * view; until it reaches 0 the view only turns to the clock.
 */
export function clockRideAllowed(tilt: number): boolean {
  return tilt === 0
}

export function rideWithClock(
  position: Vector3,
  orbitTarget: Vector3,
  target: Vector3,
  clock: Vector3,
  ride: ClockRide,
  smoothness: number,
  aspect = Infinity
): void {
  const angle = Math.atan2(-clock.z, clock.x)
  if (ride.angle === null) {
    ride.angle = angle
    ride.ease = ride.entryEase
    ride.entryEase = CLOCK_FRAMING_EASE
  }
  const turn = wrapToPi(angle - ride.angle)
  ride.angle = angle

  // Measured from the controls' target so any drag OrbitControls already
  // applied this frame is carried along rather than undone.
  offset.subVectors(position, orbitTarget).applyAxisAngle(Y, turn)
  target.applyAxisAngle(Y, turn).lerp(clock, smoothness)

  if (ride.ease > 0) {
    spherical.setFromVector3(offset)
    framed.setFromVector3(clockViewOffset(angle, canonical, aspect))
    const dTheta = wrapToPi(framed.theta - spherical.theta)
    const dPhi = framed.phi - spherical.phi
    const dRadius = framed.radius - spherical.radius
    spherical.theta += dTheta * ride.ease
    spherical.phi += dPhi * ride.ease
    // By ratio, as the main view's distance eases (main-view.ts easeDistance).
    spherical.radius *= (framed.radius / spherical.radius) ** ride.ease
    const remaining = 1 - ride.ease
    if (
      Math.abs(dTheta * remaining) < SETTLED &&
      Math.abs(dPhi * remaining) < SETTLED &&
      Math.abs(dRadius * remaining) < SETTLED * framed.radius
    ) {
      ride.ease = 0
    }
    offset.setFromSpherical(spherical)
  }

  position.addVectors(target, offset)
}

export function useClockRide(controls: EventDispatcher | null) {
  const ride = useRef<ClockRide>({ angle: null, ease: 0, entryEase: 1 })

  useEffect(() => {
    if (!controls) return
    const grab = () => {
      ride.current.ease = 0
    }
    const dispatcher = controls as EventDispatcher<{ start: object }>
    dispatcher.addEventListener('start', grab)
    return () => dispatcher.removeEventListener('start', grab)
  }, [controls])

  return ride
}
