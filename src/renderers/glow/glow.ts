// The selective glow (tides-64u): bright sources (the Sun, Earth's city
// lights and sea glint, the aurora) bloom past their edges. The spike (note
// on tides-64u) measured a full-frame bloom, HDR or not, against this and
// picked a glow layer: each source draws an emissive stand-in into a small
// target of its own, which is blurred and added over its View. Unlike a
// luminance threshold it glows only what is meant to (a daylit limb is as
// bright as a city on screen), and every existing look stays as it is: the
// scene still tone-maps straight to the canvas.
//
// This module is the pure part: the layer, the on/off rule, the targets'
// sizes and the View's rect. GlowPass.tsx draws it; glowSources.ts holds
// what each View's scene registered.
import type { QualityTier } from '../../quality'

/**
 * The three.js layer stand-ins live on. No camera renders it but GlowPass's,
 * so nothing a source adds shows in the View itself.
 */
export const GLOW_LAYER = 30

/** The glow target's size against the View's, per axis (the spike's 1/2). */
export const GLOW_SCALE = 0.5

/** Blur levels below the glow target, each half the last. */
export const GLOW_LEVELS = 5

/** No level smaller than this on a side: past it, the blur adds nothing. */
export const GLOW_MIN_LEVEL_PX = 4

/**
 * On or off for this page: ?glow=0 or ?glow=1 wins (for checks), else on
 * only on the high tier. The low tier draws none and allocates nothing: a
 * phone's GPU pays most for the extra passes, and the spike's budget is the
 * high tier's.
 */
export function resolveGlow(search: string, tier: QualityTier): boolean {
  const forced = new URLSearchParams(search).get('glow')
  if (forced === '0') return false
  if (forced === '1') return true
  return tier === 'high'
}

export interface Size {
  width: number
  height: number
}

/** The glow target's size in device px for a View of `view` device px. */
export function glowTargetSize(view: Size, scale = GLOW_SCALE): Size {
  return {
    width: Math.max(1, Math.ceil(view.width * scale)),
    height: Math.max(1, Math.ceil(view.height * scale)),
  }
}

/**
 * The blur's levels under a glow target of `target` px: each half the one
 * above (rounded up), starting at half the target, until `levels` or a side
 * under GLOW_MIN_LEVEL_PX.
 */
export function glowLevelSizes(target: Size, levels = GLOW_LEVELS, minPx = GLOW_MIN_LEVEL_PX): Size[] {
  const sizes: Size[] = []
  let width = Math.ceil(target.width / 2)
  let height = Math.ceil(target.height / 2)
  while (sizes.length < levels && width >= minPx && height >= minPx) {
    sizes.push({ width, height })
    width = Math.ceil(width / 2)
    height = Math.ceil(height / 2)
  }
  return sizes
}

/** A View's place on the canvas, CSS px, GL's origin (bottom left). */
export interface ViewViewport {
  left: number
  bottom: number
  width: number
  height: number
}

interface Box {
  left: number
  top: number
  width: number
  height: number
}

/**
 * The viewport drei's View draws `track` into on `canvas` (both client
 * rects): the same sums as drei's computeContainerPosition, so the glow lands
 * on exactly the View's pixels. Null when the View is off the canvas or empty.
 */
export function viewViewport(canvas: Box, track: Box): ViewViewport | null {
  if (!(track.width > 0 && track.height > 0)) return null
  const left = track.left - canvas.left
  const bottom = canvas.top + canvas.height - (track.top + track.height)
  if (left + track.width <= 0 || left >= canvas.width || bottom + track.height <= 0 || bottom >= canvas.height) {
    return null
  }
  return { left, bottom, width: track.width, height: track.height }
}

/**
 * How far past its sources the glow reaches, in glow-target px, with
 * `levels` blur levels: four of the coarsest level's texels (tides-0oi.15,
 * audit glow-2). The kernels' strict reach is a little wider (~170 px at 5
 * levels), but past this much every halo rounds to 0 on an 8-bit canvas
 * (measured 0 px at Sun and Earth poses), so the composite stops here.
 */
export function glowReachPx(levels: number): number {
  return 4 * 2 ** levels
}

/** A box on a View, CSS px from the View's bottom left (GL's way up). */
export interface ScreenBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * The box a sphere (centre in view space, three's camera looking down -z)
 * covers on a View of `view` CSS px under the perspective `projection`
 * (Matrix4.elements). The tangent bounds per axis, so it holds off axis,
 * where a sphere projects to an ellipse longer than its centre's radius.
 * Null when the sphere reaches the eye's plane: no finite box bounds it.
 */
export function sphereScreenBox(
  centre: { x: number; y: number; z: number },
  radius: number,
  projection: ArrayLike<number>,
  view: Size
): ScreenBox | null {
  const depth = -centre.z
  if (!(depth > radius)) return null
  const d2r2 = depth * depth - radius * radius
  // tan of the two tangent rays from the eye in the plane of `u` and depth.
  const bounds = (u: number): [number, number] => {
    const t = Math.sqrt(u * u + d2r2)
    return [(u * depth - radius * t) / d2r2, (u * depth + radius * t) / d2r2]
  }
  const [tx0, tx1] = bounds(centre.x)
  const [ty0, ty1] = bounds(centre.y)
  // ndc = scale * tan - offset (the frustum's skew, 0 when symmetric).
  const px = (ndc: number, size: number) => (ndc * 0.5 + 0.5) * size
  return {
    x0: px(projection[0] * tx0 - projection[8], view.width),
    x1: px(projection[0] * tx1 - projection[8], view.width),
    y0: px(projection[5] * ty0 - projection[9], view.height),
    y1: px(projection[5] * ty1 - projection[9], view.height),
  }
}

/**
 * The part of `viewport` (canvas CSS px) the glow can reach: `box` (View px,
 * or 'all') grown by `margin` px, clamped to the View and rounded outward.
 * Null when that is empty: nothing in reach glows on this View.
 */
export function glowCompositeRect(box: ScreenBox | 'all', margin: number, viewport: ViewViewport): ViewViewport | null {
  if (box === 'all') return viewport
  const x0 = Math.max(0, Math.floor(box.x0 - margin))
  const y0 = Math.max(0, Math.floor(box.y0 - margin))
  const x1 = Math.min(viewport.width, Math.ceil(box.x1 + margin))
  const y1 = Math.min(viewport.height, Math.ceil(box.y1 + margin))
  if (!(x1 > x0 && y1 > y0)) return null
  return { left: viewport.left + x0, bottom: viewport.bottom + y0, width: x1 - x0, height: y1 - y0 }
}
