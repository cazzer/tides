import * as THREE from 'three'
import {
  deviceQuaternion,
  lookFromQuaternion,
  readingAngles,
  smoothOrientation,
  type OrientationReading,
} from './compass'
import type { SkyLook } from './sky-look'

// How long to wait for a usable reading before deciding there's no sensor.
export const SENSOR_TIMEOUT = 1000

/** Whether to offer compass mode: the API is there and the device is touch
 * first. Desktop browsers expose the API too but have no sensor to drive it. */
export function compassSupported() {
  return (
    typeof window !== 'undefined' &&
    'DeviceOrientationEvent' in window &&
    window.matchMedia('(any-pointer: coarse)').matches
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
 * reading, and `onSilent` once if no reading with a north arrives within
 * SENSOR_TIMEOUT. Chrome reports true-north readings as
 * deviceorientationabsolute; iOS adds webkitCompassHeading to
 * deviceorientation. Returns the cleanup. */
export function followDeviceOrientation(onLook: (look: SkyLook) => void, onSilent: () => void) {
  const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation'
  const target = new THREE.Quaternion()
  const smoothed = new THREE.Quaternion()
  let last: number | null = null
  const silence = setTimeout(onSilent, SENSOR_TIMEOUT)

  const read = (event: Event) => {
    const angles = readingAngles(event as DeviceOrientationEvent & OrientationReading)
    if (!angles) return
    clearTimeout(silence)
    deviceQuaternion(angles, screenAngle(), target)
    if (last === null) smoothed.copy(target)
    else smoothOrientation(smoothed, target, event.timeStamp - last)
    last = event.timeStamp
    onLook(lookFromQuaternion(smoothed))
  }

  window.addEventListener(type, read)
  return () => {
    clearTimeout(silence)
    window.removeEventListener(type, read)
  }
}
