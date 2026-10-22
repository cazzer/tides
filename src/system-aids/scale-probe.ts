// What the main view's camera shows, measured inside the Canvas by ScaleProbe
// and read by ScaleReadout, a DOM overlay that can't see the camera. Mutable
// singleton for the same reason as shipTelemetry: per-frame values must not
// go through React state. tides-2hv.10 fills it and may add fields.

export interface ScaleProbe {
  /**
   * World units per CSS pixel in the main view, (top − bottom) / (zoom ·
   * height) as at camera.tsx:436. Null while no probe is measuring.
   */
  unitsPerPixel: number | null
}

export const scaleProbe: ScaleProbe = { unitsPerPixel: null }

/** Back to unmeasured, e.g. when the probe unmounts. */
export function resetScaleProbe(): void {
  scaleProbe.unitsPerPixel = null
}
