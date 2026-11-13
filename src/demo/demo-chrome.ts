// The demo's boxes over the scene, its caption bar and readouts
// (tides-zec.15), so the main view can frame its bodies in the band they
// leave clear. The focus title (FocusTitle.tsx) is one too, in and out of
// the tours: the framing (DemoPlayer) reads the boxes only while a demo
// runs, and BodyLabels keeps the bodies' names in the band every frame
// (clearBand's `out`, so that allocates nothing). Their rects are measured when they resize or the window does,
// never in the frame loop: the bar's clock rewrites its text every frame, and
// reading layout after that would force a reflow each frame.

import { useCallback } from 'react'

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

const boxes = new Map<Element, Rect>()
let observer: ResizeObserver | null = null

function measure() {
  for (const element of boxes.keys()) boxes.set(element, element.getBoundingClientRect())
}

function track(element: Element): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {}
  if (!observer) {
    observer = new ResizeObserver(measure)
    window.addEventListener('resize', measure)
  }
  boxes.set(element, element.getBoundingClientRect())
  observer.observe(element)
  return () => {
    boxes.delete(element)
    observer?.unobserve(element)
    if (boxes.size === 0) {
      observer?.disconnect()
      observer = null
      window.removeEventListener('resize', measure)
    }
  }
}

/** A ref that counts its element as one of the demo's boxes while mounted. */
export function useDemoChromeRef<T extends Element>(): (element: T | null) => (() => void) | undefined {
  return useCallback((element: T | null) => (element ? track(element) : undefined), [])
}

/** The demo's boxes as last measured, in viewport px. */
export function demoChromeRects(): Iterable<Rect> {
  return boxes.values()
}

/** Space kept between a box and the band, px. */
const BAND_MARGIN = 8

/** A band of a view, px from its top. */
export interface Band {
  top: number
  bottom: number
}

/**
 * The band of `view` (viewport px) clear of `chrome`, as px from the view's
 * top. Only boxes over the middle 40% of the view's width count, where the
 * focus is framed: a readout in a desktop corner leaves the middle clear. A
 * box in the view's lower half bounds the band from below, else from above.
 * Written into `out` when given, and returned.
 */
export function clearBand(view: Rect, chrome: Iterable<Rect>, out: Band = { top: 0, bottom: 0 }): Band {
  const height = view.bottom - view.top
  const width = view.right - view.left
  const middleLeft = view.left + 0.3 * width
  const middleRight = view.right - 0.3 * width
  let top = 0
  let bottom = height
  for (const box of chrome) {
    if (box.right <= middleLeft || box.left >= middleRight) continue
    if (box.bottom <= view.top || box.top >= view.bottom) continue
    if ((box.top + box.bottom) / 2 - view.top > height / 2) {
      bottom = Math.min(bottom, box.top - view.top - BAND_MARGIN)
    } else top = Math.max(top, box.bottom - view.top + BAND_MARGIN)
  }
  // Boxes leaving almost nothing: frame in the whole view rather than a sliver.
  const sliver = bottom - top < 0.3 * height
  out.top = sliver ? 0 : top
  out.bottom = sliver ? height : bottom
  return out
}

/**
 * How the main view frames a band `top`..`bottom` px of a view `height` px
 * tall with vertical field `vfovDeg`: the projection's shift down the view
 * (setViewOffset's y, px) that puts the view's centre at the band's, and the
 * band's own vertical field (deg), for fitting a pose into it.
 */
export function bandFraming(
  band: { top: number; bottom: number },
  height: number,
  vfovDeg: number
): { offsetY: number; vfov: number } {
  const bandHeight = band.bottom - band.top
  const halfTan = Math.tan((vfovDeg * Math.PI) / 360)
  return {
    offsetY: height / 2 - (band.top + band.bottom) / 2,
    vfov: (2 * Math.atan((bandHeight / height) * halfTan) * 180) / Math.PI,
  }
}
