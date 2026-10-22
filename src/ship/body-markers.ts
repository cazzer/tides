// Minimum-size body markers (tides-2hv.12). At the flight scale a planet
// across the system is a fraction of a pixel (Jupiter is ~0.3 px from
// Earth), so the scene alone can't show where it is. Each planet, and a
// targeted moon, gets a small DOM dot at its projected centre that fades out
// as the real disc grows past a few pixels. DOM rather than R3F points, like
// the target brackets: exact pixel sizes, and no depth fight with the body's
// own sphere. The Sun has none; its far glare (SunRenderer) does that job.

import { isMoonBody, type ScreenBody } from './ship-targeting'
import { smoothstep } from './dust'

/** Dot diameter, CSS px (plus a 1 px dark rim). */
export const MARKER_DOT_PX = 5

/**
 * [TUNE] Projected disc radius, px, over which the dot fades out: full under
 * 1.5 (a 3 px disc), gone by 4, where the disc itself reads.
 */
export const MARKER_FADE_PX: readonly [number, number] = [1.5, 4]

/** Below this opacity a dot is hidden rather than drawn faintly. */
const MIN_OPACITY = 0.01

/** Whether `key` gets a marker: planets always, a moon only as the target. */
export function isMarked(key: string, targetKey: string | null): boolean {
  if (key === 'sun') return false
  return !isMoonBody(key) || key === targetKey
}

/** The dot's opacity for a disc of `radiusPx`. */
export function markerOpacity(radiusPx: number): number {
  if (!(radiusPx >= 0)) return 0
  return 1 - smoothstep(MARKER_FADE_PX[0], MARKER_FADE_PX[1], radiusPx)
}

/**
 * Whether a nearer body's projected disc covers all of `body`'s dot, so the
 * dot would float over that body. Only a disc as big as the dot can: from
 * afar Jupiter's moons sit in front of it at a fraction of a pixel, and
 * must not hide its dot. `screens` holds every body this frame.
 */
export function isOccluded(body: ScreenBody, screens: readonly ScreenBody[]): boolean {
  for (const other of screens) {
    if (other === body || !other.inFront || !(other.distance < body.distance)) continue
    const apart = Math.hypot(other.x - body.x, other.y - body.y)
    if (apart + MARKER_DOT_PX / 2 <= other.radiusPx) return true
  }
  return false
}

export interface MarkerPlacement {
  visible: boolean
  x: number
  y: number
  opacity: number
}

export function createMarkerPlacement(): MarkerPlacement {
  return { visible: false, x: 0, y: 0, opacity: 0 }
}

/**
 * Where `body`'s dot goes on a `width` × `height` view, into `out`: hidden
 * behind the camera, off screen, behind a nearer disc, or once its own disc
 * is big enough to see.
 */
export function placeMarker(
  body: ScreenBody,
  screens: readonly ScreenBody[],
  width: number,
  height: number,
  out: MarkerPlacement
): MarkerPlacement {
  out.x = body.x
  out.y = body.y
  out.opacity = markerOpacity(body.radiusPx)
  out.visible =
    body.inFront &&
    out.opacity >= MIN_OPACITY &&
    body.x >= 0 &&
    body.x <= width &&
    body.y >= 0 &&
    body.y <= height &&
    !isOccluded(body, screens)
  return out
}

// What each dot last showed, so the frame loop writes the DOM only on change.
const shown = new WeakMap<HTMLElement, MarkerPlacement>()

/** Apply `placement` to a marker element, touching only what changed. */
export function applyMarker(element: HTMLElement, placement: MarkerPlacement): void {
  let last = shown.get(element)
  if (!last) {
    last = createMarkerPlacement()
    last.visible = !element.hidden
    last.opacity = NaN
    last.x = NaN
    shown.set(element, last)
  }
  if (placement.visible !== last.visible) {
    element.hidden = !placement.visible
    last.visible = placement.visible
  }
  if (!placement.visible) return
  const half = MARKER_DOT_PX / 2
  // Tenths of a pixel and hundredths of opacity: finer is invisible.
  const x = Math.round((placement.x - half) * 10) / 10
  const y = Math.round((placement.y - half) * 10) / 10
  if (x !== last.x || y !== last.y) {
    element.style.transform = `translate(${x}px, ${y}px)`
    last.x = x
    last.y = y
  }
  const opacity = Math.round(placement.opacity * 100) / 100
  if (opacity !== last.opacity) {
    element.style.opacity = String(opacity)
    last.opacity = opacity
  }
}

/**
 * The marker elements BodyMarkers renders, for ShipTargeting to place each
 * frame: one per planet (and Earth) by key, and one shared by whichever moon
 * is targeted.
 */
export const bodyMarkers: {
  planets: Map<string, HTMLElement>
  moon: HTMLElement | null
} = { planets: new Map(), moon: null }
