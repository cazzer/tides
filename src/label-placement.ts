// Screen-space placement for small labels beside a body, clear of other
// labels drawn as strips (the month names, the clock, labels already
// placed). Units are screen pixels with y up. This runs every frame, so it
// writes into caller-owned objects and allocates nothing.

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** A segment from a to b, thickened by r on every side. */
export interface Strip {
  ax: number
  ay: number
  bx: number
  by: number
  r: number
}

export type LabelSide =
  | 'right'
  | 'above-right'
  | 'below-right'
  | 'above'
  | 'below'
  | 'left'
  | 'above-left'
  | 'below-left'

/** Tried in this order when the current side is blocked. */
export const LABEL_SIDES: readonly LabelSide[] = [
  'right',
  'above-right',
  'below-right',
  'above',
  'below',
  'left',
  'above-left',
  'below-left',
]

/**
 * A label keeps its side until that side is blocked by more than this, and
 * with every side blocked moves only to one at least this much less
 * blocked, so a pixel's shift in the layout doesn't flip it back and forth.
 */
export const SIDE_HYSTERESIS_PX = 2

export function emptyRect(): Rect {
  return { x0: 0, y0: 0, x1: 0, y1: 0 }
}

export function emptyStrip(): Strip {
  return { ax: 0, ay: 0, bx: 0, by: 0, r: 0 }
}

/**
 * Writes into `out` the box a `width` × `height` label takes on `side` of a
 * body centred at (cx, cy) whose disc reaches `clearance` from its centre.
 */
export function labelRect(
  side: LabelSide,
  cx: number,
  cy: number,
  clearance: number,
  width: number,
  height: number,
  out: Rect
): Rect {
  const c = clearance
  const d = clearance * Math.SQRT1_2
  let x0: number
  let y0: number
  switch (side) {
    case 'right':
      x0 = cx + c
      y0 = cy - height / 2
      break
    case 'left':
      x0 = cx - c - width
      y0 = cy - height / 2
      break
    case 'above':
      x0 = cx - width / 2
      y0 = cy + c
      break
    case 'below':
      x0 = cx - width / 2
      y0 = cy - c - height
      break
    case 'above-right':
      x0 = cx + d
      y0 = cy + d
      break
    case 'below-right':
      x0 = cx + d
      y0 = cy - d - height
      break
    case 'above-left':
      x0 = cx - d - width
      y0 = cy + d
      break
    case 'below-left':
      x0 = cx - d - width
      y0 = cy - d - height
      break
  }
  out.x0 = x0
  out.y0 = y0
  out.x1 = x0 + width
  out.y1 = y0 + height
  return out
}

/**
 * Writes into `out` a strip covering `rect` and `margin` around it: the
 * rect's long centreline thickened by half its short side. Its corners come
 * out rounded, a shortfall of under half the short side that the margin
 * makes up.
 */
export function rectAsStrip(rect: Rect, margin: number, out: Strip): Strip {
  const w = rect.x1 - rect.x0
  const h = rect.y1 - rect.y0
  if (w >= h) {
    const cy = (rect.y0 + rect.y1) / 2
    out.ax = rect.x0 + h / 2
    out.bx = rect.x1 - h / 2
    out.ay = cy
    out.by = cy
    out.r = h / 2 + margin
  } else {
    const cx = (rect.x0 + rect.x1) / 2
    out.ax = cx
    out.bx = cx
    out.ay = rect.y0 + w / 2
    out.by = rect.y1 - w / 2
    out.r = w / 2 + margin
  }
  return out
}

// Liang–Barsky: does the segment cross the (closed) rect? Each edge clips
// the segment's parameter range [t0, t1]; it misses once that is empty.
function segmentCrossesRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rect: Rect
): boolean {
  const dx = bx - ax
  const dy = by - ay
  let t0 = 0
  let t1 = 1
  if (dx === 0) {
    if (ax < rect.x0 || ax > rect.x1) return false
  } else {
    const ta = (rect.x0 - ax) / dx
    const tb = (rect.x1 - ax) / dx
    t0 = Math.max(t0, Math.min(ta, tb))
    t1 = Math.min(t1, Math.max(ta, tb))
    if (t0 > t1) return false
  }
  if (dy === 0) {
    if (ay < rect.y0 || ay > rect.y1) return false
  } else {
    const ta = (rect.y0 - ay) / dy
    const tb = (rect.y1 - ay) / dy
    t0 = Math.max(t0, Math.min(ta, tb))
    t1 = Math.min(t1, Math.max(ta, tb))
  }
  return t0 <= t1
}

function pointToRect(x: number, y: number, rect: Rect): number {
  const dx = Math.max(rect.x0 - x, 0, x - rect.x1)
  const dy = Math.max(rect.y0 - y, 0, y - rect.y1)
  return Math.sqrt(dx * dx + dy * dy)
}

function pointToSegment(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const u =
    l2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / l2))
  const ex = x - ax - u * dx
  const ey = y - ay - u * dy
  return Math.sqrt(ex * ex + ey * ey)
}

/** How far the rect stays clear of the strip; negative where they overlap. */
export function stripClearance(rect: Rect, s: Strip): number {
  if (segmentCrossesRect(s.ax, s.ay, s.bx, s.by, rect)) return -s.r
  // Apart, the nearest points are an endpoint and the rect or a corner and
  // the segment.
  const gap = Math.min(
    pointToRect(s.ax, s.ay, rect),
    pointToRect(s.bx, s.by, rect),
    pointToSegment(rect.x0, rect.y0, s.ax, s.ay, s.bx, s.by),
    pointToSegment(rect.x1, rect.y0, s.ax, s.ay, s.bx, s.by),
    pointToSegment(rect.x0, rect.y1, s.ax, s.ay, s.bx, s.by),
    pointToSegment(rect.x1, rect.y1, s.ax, s.ay, s.bx, s.by)
  )
  return gap - s.r
}

/** The least clearance of `rect` from the first `count` strips. */
export function rectRoom(
  rect: Rect,
  strips: readonly Strip[],
  count: number
): number {
  let room = Infinity
  for (let i = 0; i < count; i++) {
    const c = stripClearance(rect, strips[i])
    if (c < room) room = c
  }
  return room
}

const candidate = emptyRect()

function sideRoom(
  side: LabelSide,
  cx: number,
  cy: number,
  clearance: number,
  width: number,
  height: number,
  strips: readonly Strip[],
  count: number
): number {
  labelRect(side, cx, cy, clearance, width, height, candidate)
  return rectRoom(candidate, strips, count)
}

/**
 * The side for a label now on `current`, clear of the first `count` strips.
 * It stays while that side is blocked by no more than SIDE_HYSTERESIS_PX;
 * otherwise it takes the first clear side in LABEL_SIDES order, or, with
 * every side blocked, the least blocked one if that beats staying by more
 * than SIDE_HYSTERESIS_PX.
 */
export function chooseLabelSide(
  current: LabelSide,
  cx: number,
  cy: number,
  clearance: number,
  width: number,
  height: number,
  strips: readonly Strip[],
  count: number
): LabelSide {
  const currentRoom = sideRoom(
    current,
    cx,
    cy,
    clearance,
    width,
    height,
    strips,
    count
  )
  if (currentRoom > -SIDE_HYSTERESIS_PX) return current

  let best = current
  let bestRoom = currentRoom
  for (let i = 0; i < LABEL_SIDES.length; i++) {
    const side = LABEL_SIDES[i]
    if (side === current) continue
    const room = sideRoom(side, cx, cy, clearance, width, height, strips, count)
    if (room > 0) return side
    if (room > bestRoom) {
      best = side
      bestRoom = room
    }
  }
  return bestRoom > currentRoom + SIDE_HYSTERESIS_PX ? best : current
}
