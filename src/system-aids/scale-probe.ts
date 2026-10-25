// What the main view's camera shows, measured inside the Canvas by ScaleProbe
// and read by ScaleReadout, a DOM overlay that can't see the camera. Mutable
// singleton for the same reason as shipTelemetry: per-frame values must not
// go through React state.
import type { Camera, Vector3 } from 'three'
import { worldUnitsPerPixel } from './pixel-scale'

export interface ScaleProbe {
  /**
   * World units per CSS pixel in the main view at its controls' target, the
   * one depth a perspective view has a single scale at. Null while no probe
   * is measuring, or before the controls exist.
   */
  unitsPerPixel: number | null
}

export const scaleProbe: ScaleProbe = { unitsPerPixel: null }

/**
 * Measure `camera` at `target`, in a view `heightPx` CSS pixels tall, into
 * scaleProbe.
 */
export function measureScale(camera: Camera, target: Vector3 | undefined, heightPx: number): void {
  scaleProbe.unitsPerPixel =
    target && heightPx > 0 ? worldUnitsPerPixel(camera, target, heightPx) : null
}

/** Back to unmeasured, e.g. when the probe unmounts. */
export function resetScaleProbe(): void {
  scaleProbe.unitsPerPixel = null
}
