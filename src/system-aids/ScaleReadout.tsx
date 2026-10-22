// The system view's scale bar and distance readout (tides-2hv.10). A DOM
// overlay in the main Panel (App.tsx), mounted while the planets and
// systemAids.scale are on and the system view fills the 'main' grid area.
// It can't see the camera, so it reads scaleProbe (scale-probe.ts), which
// ScaleProbe writes from inside the Canvas.
//
// Three lines, bottom-right above the ship button:
//   [bar] 2 AU
//   at Jupiter's orbit · gaps between orbits are squeezed
//   Jupiter · 5.21 AU from Earth          (with the camera on a body but Earth)
// On a short view (a phone held landscape) one line beside the ship button
// instead, "[bar] 2 AU · at Jupiter's orbit" (index.css). What the bar can
// honestly claim is scale-readout-math.ts.
//
// Like ShipHud, one requestAnimationFrame loop writes to the DOM through
// refs, and only what changed: the bar's width as the zoom moves, the text
// when it changes, and the true distances (an ephemeris call) a few times a
// second.
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
  scaleCaptionShort,
  scaleReference,
} from './scale-readout-math'

// The true distances move slowly; recomputing them this often is plenty.
const TRUTH_INTERVAL_MS = 250

interface Lines {
  root: HTMLDivElement | null
  bar: HTMLSpanElement | null
  length: HTMLSpanElement | null
  short: HTMLSpanElement | null
  caption: HTMLDivElement | null
  distance: HTMLDivElement | null
}

function setText(element: HTMLElement | null, text: string) {
  if (element && element.textContent !== text) element.textContent = text
}

function setHidden(element: HTMLElement | null, hidden: boolean) {
  if (element && element.hidden !== hidden) element.hidden = hidden
}

export function ScaleReadout() {
  const lines = useRef<Lines>({
    root: null,
    bar: null,
    length: null,
    short: null,
    caption: null,
    distance: null,
  })

  useEffect(() => {
    let frame = 0
    let truthAt = -Infinity
    let truthFocus: string | null = null
    let unitKm = NaN
    let barKm = NaN
    let barPx = NaN
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      const l = lines.current
      const upp = scaleProbe.unitsPerPixel
      const { timestamp, cameraFocus } = useStore.getState()
      setHidden(l.root, upp == null || timestamp == null)
      if (upp == null || timestamp == null) return

      // A new focus can't wait for the next refresh: its bar is another scale.
      if (now - truthAt >= TRUTH_INTERVAL_MS || cameraFocus !== truthFocus) {
        truthAt = now
        truthFocus = cameraFocus
        const reference = scaleReference(cameraFocus)
        unitKm = kmPerUnit(reference, timestamp)
        setText(l.caption, scaleCaption(reference))
        setText(l.short, ` · ${scaleCaptionShort(reference)}`)
        const target = distanceTarget(cameraFocus)
        setText(l.distance, target ? distanceLine(target, distanceFromEarthKm(target, timestamp)) : '')
        setHidden(l.distance, target == null)
      }

      const kmPerPx = unitKm * upp
      const km = niceScaleBarKm(kmPerPx)
      if (km !== barKm) {
        barKm = km
        setText(l.length, formatDistance(km))
      }
      // Half pixels: finer than that is invisible, and each write restyles.
      const px = Math.round((2 * km) / kmPerPx) / 2
      if (px !== barPx && l.bar) {
        barPx = px
        l.bar.style.width = `${px}px`
      }
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
        <span>
          <span
            ref={(el) => {
              lines.current.length = el
            }}
          />
          <span
            className="scale-readout__short"
            ref={(el) => {
              lines.current.short = el
            }}
          />
        </span>
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
