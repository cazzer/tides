// The composite's scissor (glow-pass.ts, tides-0oi.15) stops glowReachPx past
// the sources. This emulates the blur on the CPU, its taps read from the
// shaders themselves, and holds what lies past that reach far below an 8-bit
// step, so a change to the levels, the kernels, the spread, the strength or
// the display power can't open a seam at the scissor's edge unnoticed.
import { describe, expect, it } from 'vitest'
import { GLOW_LEVELS, glowLevelSizes, glowReachPx } from './glow'
import { GLOW_DISPLAY_POWER, GLOW_SPREAD, GLOW_STRENGTH, glowBlurShaders, glowBlurWeight } from './glow-pass'

interface Tap {
  x: number
  y: number
  w: number
}

// Every `texture2D(tSource, vUv [+ uTexel * vec2(x, y)]).rgb [* w]` tap.
function tapsOf(glsl: string): Tap[] {
  const re = /texture2D\(tSource, vUv(?: \+ uTexel \* vec2\((-?[\d.]+), (-?[\d.]+)\))?\)\.rgb(?: \* ([\d.]+))?/g
  return [...glsl.matchAll(re)].map((m) => ({ x: +(m[1] ?? 0), y: +(m[2] ?? 0), w: +(m[3] ?? 1) }))
}

interface Grid {
  w: number
  h: number
  d: Float64Array
}

const grid = (w: number, h: number): Grid => ({ w, h, d: new Float64Array(w * h) })

// Bilinear, clamped to the edge, as the targets' LinearFilter samples.
function sample(t: Grid, u: number, v: number): number {
  const x = u * t.w - 0.5
  const y = v * t.h - 0.5
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const at = (i: number, j: number) => t.d[Math.min(t.h - 1, Math.max(0, j)) * t.w + Math.min(t.w - 1, Math.max(0, i))]
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
}

const down = tapsOf(glowBlurShaders.down)
const up = tapsOf(glowBlurShaders.up)
const downScale = +glowBlurShaders.down.match(/s \* ([\d.]+), 1\.0\)/)![1]
const upDivisor = +glowBlurShaders.up.match(/uSpread \/ ([\d.]+)\)/)![1]

// The blur's finest level (glow-pass.ts blur()) for one unit source texel at
// (sx, sy) in a W x H glow target, as the composite reads it (times uNorm).
function blurOfPoint(W: number, H: number, sx: number, sy: number) {
  const source = grid(W, H)
  source.d[sy * W + sx] = 1
  const levels = glowLevelSizes({ width: W, height: H }).map((s) => grid(s.width, s.height))
  let from = source
  for (const t of levels) {
    const tx = 1 / from.w
    const ty = 1 / from.h
    for (let j = 0; j < t.h; j++)
      for (let i = 0; i < t.w; i++) {
        const u = (i + 0.5) / t.w
        const v = (j + 0.5) / t.h
        let s = 0
        for (const k of down) s += sample(from, u + k.x * tx, v + k.y * ty) * k.w
        t.d[j * t.w + i] = s * downScale
      }
    from = t
  }
  for (let n = levels.length - 1; n > 0; n--) {
    const s = levels[n]
    const t = levels[n - 1]
    const tx = 0.5 / s.w
    const ty = 0.5 / s.h
    const add = new Float64Array(t.w * t.h)
    for (let j = 0; j < t.h; j++)
      for (let i = 0; i < t.w; i++) {
        const u = (i + 0.5) / t.w
        const v = (j + 0.5) / t.h
        let a = 0
        for (const k of up) a += sample(s, u + k.x * tx, v + k.y * ty) * k.w
        add[j * t.w + i] = (a * GLOW_SPREAD) / upDivisor
      }
    for (let m = 0; m < add.length; m++) t.d[m] += add[m]
  }
  const norm = 1 / glowBlurWeight(levels.length)
  return (u: number, v: number) => sample(levels[0], u, v) * norm
}

describe('the glow past glowReachPx', () => {
  const W = 640
  const H = 640
  const reach = glowReachPx(GLOW_LEVELS)

  it('reads its taps from the shaders', () => {
    expect(down.length).toBeGreaterThan(1)
    expect(up.length).toBeGreaterThan(1)
  })

  // A source texel at a few phases against the coarse levels' grid.
  for (const [sx, sy] of [
    [320, 320],
    [325, 311],
    [333, 343],
    [351, 302],
  ]) {
    it(`is under 1e-8 of a unit source and under half an 8-bit step at (${sx}, ${sy})`, () => {
      const glow = blurOfPoint(W, H, sx, sy)
      const peak = glow((sx + 0.5) / W, (sy + 0.5) / H)
      // Every canvas px (half a target texel) whose box distance from the
      // source texel's extent is past the reach.
      let tail = 0
      for (let j = 0; j < 2 * H; j++)
        for (let i = 0; i < 2 * W; i++) {
          const x = (i + 0.5) / 2
          const y = (j + 0.5) / 2
          const dx = Math.max(sx - x, x - (sx + 1))
          const dy = Math.max(sy - y, y - (sy + 1))
          if (Math.max(dx, dy) <= reach) continue
          tail = Math.max(tail, glow(x / W, y / H))
        }
      expect(peak).toBeGreaterThan(1e-3)
      expect(tail).toBeLessThan(1e-8)
      // A million unit texels all at the reach's edge, through the composite.
      const display = Math.pow(1 - Math.exp(-tail * 1e6 * GLOW_STRENGTH), GLOW_DISPLAY_POWER)
      expect(display).toBeLessThan(0.5 / 255)
    })
  }
})
