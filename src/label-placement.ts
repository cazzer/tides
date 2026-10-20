// Screen-space placement for small labels beside a body, clear of longer
// labels drawn as strips (the month names and the clock). Units are screen
// pixels with y up.

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
 * The box a `width` × `height` label takes on `side` of a body centred at
 * (cx, cy) whose disc reaches `clearance` from its centre.
 */
export function labelRect(
  side: LabelSide,
  cx: number,
  cy: number,
  clearance: number,
  width: number,
  height: number
): Rect {
  const c = clearance
  const d = clearance * Math.SQRT1_2
  switch (side) {
    case 'right':
      return box(cx + c, cy - height / 2, width, height)
    case 'left':
      return box(cx - c - width, cy - height / 2, width, height)
    case 'above':
      return box(cx - width / 2, cy + c, width, height)
    case 'below':
      return box(cx - width / 2, cy - c - height, width, height)
    case 'above-right':
      return box(cx + d, cy + d, width, height)
    case 'below-right':
      return box(cx + d, cy - d - height, width, height)
    case 'above-left':
      return box(cx - d - width, cy + d, width, height)
    case 'below-left':
      return box(cx - d - width, cy - d - height, width, height)
  }
}

function box(x0: number, y0: number, width: number, height: number): Rect {
  return { x0, y0, x1: x0 + width, y1: y0 + height }
}

// Liang–Barsky: does the segment cross the (closed) rect?
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
  const edges: [number, number][] = [
    [-dx, ax - rect.x0],
    [dx, rect.x1 - ax],
    [-dy, ay - rect.y0],
    [dy, rect.y1 - ay],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false
    } else {
      const t = q / p
      if (p < 0) t0 = Math.max(t0, t)
      else t1 = Math.min(t1, t)
      if (t0 > t1) return false
    }
  }
  return true
}

function pointToRect(x: number, y: number, rect: Rect): number {
  const dx = Math.max(rect.x0 - x, 0, x - rect.x1)
  const dy = Math.max(rect.y0 - y, 0, y - rect.y1)
  return Math.hypot(dx, dy)
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
  return Math.hypot(x - ax - u * dx, y - ay - u * dy)
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

/**
 * The first side in LABEL_SIDES order that is clear of every strip, or, with
 * all of them blocked, the one that overlaps least. A function of the layout
 * alone, so the label only moves when the picture does.
 */
export function chooseLabelSide(
  cx: number,
  cy: number,
  clearance: number,
  width: number,
  height: number,
  strips: readonly Strip[]
): LabelSide {
  let best = LABEL_SIDES[0]
  let bestRoom = -Infinity
  for (const side of LABEL_SIDES) {
    const rect = labelRect(side, cx, cy, clearance, width, height)
    const room = strips.reduce(
      (min, s) => Math.min(min, stripClearance(rect, s)),
      Infinity
    )
    if (room > 0) return side
    if (room > bestRoom) {
      best = side
      bestRoom = room
    }
  }
  return best
}
