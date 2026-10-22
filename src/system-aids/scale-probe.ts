// What the main view's camera shows, measured inside the Canvas by ScaleProbe
// and read by ScaleReadout, a DOM overlay that can't see the camera. Mutable
// singleton for the same reason as shipTelemetry: per-frame values must not
// go through React state.
import type { Camera, OrthographicCamera } from 'three'
import { orthoUnitsPerPixel } from './pixel-scale'

export interface ScaleProbe {
  /**
   * World units per CSS pixel in the main view, (top − bottom) / (zoom ·
   * height) as at camera.tsx:436. Null while no probe is measuring, or while
   * the camera isn't orthographic (then no one scale holds across the view).
   */
  unitsPerPixel: number | null
}

export const scaleProbe: ScaleProbe = { unitsPerPixel: null }

/** Measure `camera`, in a view `heightPx` CSS pixels tall, into scaleProbe. */
export function measureScale(camera: Camera, heightPx: number): void {
  const ortho = camera as OrthographicCamera
  scaleProbe.unitsPerPixel =
    ortho.isOrthographicCamera && heightPx > 0
      ? orthoUnitsPerPixel(ortho.top, ortho.bottom, ortho.zoom, heightPx)
      : null
}

/** Back to unmeasured, e.g. when the probe unmounts. */
export function resetScaleProbe(): void {
  scaleProbe.unitsPerPixel = null
}
