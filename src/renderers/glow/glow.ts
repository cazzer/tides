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
