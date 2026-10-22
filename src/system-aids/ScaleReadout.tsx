// The system view's scale bar and distance readout (tides-2hv.10). A DOM
// overlay in the main Panel (App.tsx), mounted while the planets and
// systemAids.scale are on and the system view fills the 'main' grid area.
// It can't see the camera, so it reads scaleProbe (scale-probe.ts), which
// ScaleProbe writes from inside the Canvas.
//
// Three lines, bottom-right above the ship button:
//   [bar] 2 AU
//   along Jupiter's orbit · not to scale between orbits
//   Jupiter · 5.21 AU from Earth          (with the camera on a body but Earth)
// What the bar can honestly claim is scale-readout-math.ts.
//
// Like ShipHud, one requestAnimationFrame loop writes to the DOM through
// refs: the bar every frame, so it tracks a pinch; the text only when it
// changes, and the true distances (an ephemeris call) a few times a second.
import { useEffect, useRef } from 'react'
import { formatDistance } from '../ship/ship-distances'
import { useStore } from '../store'
import { scaleProbe } from './scale-probe'
import {
  distanceFromEarthKm,
  distanceLine,
  distanceTarget,
  kmPerUnit,
  niceScaleBarKm,
  scaleCaption,
  scaleReference,
} from './scale-readout-math'

// The true distances move slowly; recomputing them this often is plenty.
const TRUTH_INTERVAL_MS = 250

interface Lines {
  root: HTMLDivElement | null
  bar: HTMLSpanElement | null
  length: HTMLSpanElement | null
  caption: HTMLDivElement | null
  distance: HTMLDivElement | null
}

function setText(element: HTMLElement | null, text: string) {
  if (element && element.textContent !== text) element.textContent = text
}

export function ScaleReadout() {
  const lines = useRef<Lines>({ root: null, bar: null, length: null, caption: null, distance: null })

  useEffect(() => {
    let frame = 0
    let truthAt = -Infinity
    let truthFocus: string | null = null
    let unitKm = NaN
    let barKm = NaN
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      const l = lines.current
      const upp = scaleProbe.unitsPerPixel
      const { timestamp, cameraFocus } = useStore.getState()
      if (l.root) l.root.hidden = upp == null || timestamp == null
      if (upp == null || timestamp == null) return

      // A new focus can't wait for the next refresh: its bar is another scale.
      if (now - truthAt >= TRUTH_INTERVAL_MS || cameraFocus !== truthFocus) {
        truthAt = now
        truthFocus = cameraFocus
        const reference = scaleReference(cameraFocus)
        unitKm = kmPerUnit(reference, timestamp)
        setText(l.caption, scaleCaption(reference))
        const target = distanceTarget(cameraFocus)
        setText(l.distance, target ? distanceLine(target, distanceFromEarthKm(target, timestamp)) : '')
        if (l.distance) l.distance.hidden = target == null
      }

      const kmPerPx = unitKm * upp
      const km = niceScaleBarKm(kmPerPx)
      if (km !== barKm) {
        barKm = km
        setText(l.length, formatDistance(km))
      }
      if (l.bar) l.bar.style.width = `${km / kmPerPx}px`
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div
      className="scale-readout"
      ref={(el) => {
        lines.current.root = el
      }}
      // Shown by the loop once the probe has measured.
      hidden
    >
      <div className="scale-readout__scale">
        <span
          className="scale-readout__bar"
          ref={(el) => {
            lines.current.bar = el
          }}
        />
        <span
          ref={(el) => {
            lines.current.length = el
          }}
        />
      </div>
      <div
        className="scale-readout__caption"
        ref={(el) => {
          lines.current.caption = el
        }}
      />
      <div
        className="scale-readout__distance"
        ref={(el) => {
          lines.current.distance = el
        }}
        hidden
      />
    </div>
  )
}
