import * as THREE from 'three'
import {
  deviceQuaternion,
  lookFromQuaternion,
  nextNorthOffset,
  readingAngles,
  smoothOrientation,
  type NorthOffset,
  type OrientationReading,
} from './compass'
import type { SkyLook } from './sky-look'

// How long to wait for any reading before deciding there's no sensor.
export const SENSOR_TIMEOUT = 1000
// How long readings may come without a north (iOS reports a heading of −1
// while its compass calibrates) before giving up on one.
export const NORTH_TIMEOUT = 5000

export type Silence = 'no-sensor' | 'no-north'

/** Whether to offer compass mode: the API is there and the device is touch
 * first. Desktop browsers expose the API too but have no sensor to drive it. */
export function compassSupported() {
  return (
    typeof window !== 'undefined' &&
    'DeviceOrientationEvent' in window &&
    window.matchMedia('(pointer: coarse)').matches
  )
}

type PermissionRequester = { requestPermission?: () => Promise<PermissionState | 'granted'> }

/** Asks for motion access where the browser gates it (iOS Safari). Call it
 * straight from the tap: iOS only prompts during a user gesture. */
export async function requestOrientation() {
  const request = (DeviceOrientationEvent as unknown as PermissionRequester).requestPermission
  if (!request) return true
  try {
    return (await request.call(DeviceOrientationEvent)) === 'granted'
  } catch {
    return false
  }
}

function screenAngle() {
  return screen.orientation?.angle ?? Number((window as { orientation?: number }).orientation ?? 0)
}

/** Calls `onLook` with the smoothed look out of the phone's back on every
 * reading with a north, and `onSilent` once if no reading arrives within
 * SENSOR_TIMEOUT or none with a north within NORTH_TIMEOUT. Chrome reports
 * north-referenced readings as deviceorientationabsolute; iOS adds
 * webkitCompassHeading to deviceorientation. Returns the cleanup. */
export function followDeviceOrientation(
  onLook: (look: SkyLook) => void,
  onSilent: (silence: Silence) => void
) {
  const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation'
  const target = new THREE.Quaternion()
  const smoothed = new THREE.Quaternion()
  let last: number | null = null
  let northOffset: NorthOffset | null = null
  const noSensor = setTimeout(() => {
    clearTimeout(noNorth)
    onSilent('no-sensor')
  }, SENSOR_TIMEOUT)
  const noNorth = setTimeout(() => onSilent('no-north'), NORTH_TIMEOUT)

  const read = (event: Event) => {
    const reading = event as DeviceOrientationEvent & OrientationReading
    if (reading.beta == null || reading.gamma == null) return
    clearTimeout(noSensor)
    northOffset = nextNorthOffset(northOffset, reading)
    const angles = readingAngles(reading, northOffset)
    if (!angles) return
    clearTimeout(noNorth)
    deviceQuaternion(angles, screenAngle(), target)
    if (last === null) smoothed.copy(target)
    else smoothOrientation(smoothed, target, event.timeStamp - last)
    last = event.timeStamp
    onLook(lookFromQuaternion(smoothed))
  }

  window.addEventListener(type, read)
  return () => {
    clearTimeout(noSensor)
    clearTimeout(noNorth)
    window.removeEventListener(type, read)
  }
}
