import { describe, expect, it } from 'vitest'
import { BARE_TRUESCALE, DEFAULT_TRUESCALE, MAX_TRUESCALE, TRUESCALE, parseTrueScale, towardTrue } from './truescale'

describe('parseTrueScale', () => {
  it('is the cap when absent, so true scale is on by default', () => {
    expect(DEFAULT_TRUESCALE).toBe(MAX_TRUESCALE)
    expect(parseTrueScale('')).toBe(MAX_TRUESCALE)
    expect(parseTrueScale('?ship=1&relief=12')).toBe(MAX_TRUESCALE)
  })

  it('reads a bare or empty flag as halfway', () => {
    expect(BARE_TRUESCALE).toBe(0.5)
    expect(parseTrueScale('?truescale')).toBe(0.5)
    expect(parseTrueScale('?truescale=')).toBe(0.5)
    expect(parseTrueScale('?ship=1&truescale=%20')).toBe(0.5)
  })

  it('reads the factor, clamped to [0, MAX_TRUESCALE]', () => {
    expect(parseTrueScale('?truescale=0.3')).toBe(0.3)
    expect(parseTrueScale('?ship=1&truescale=0.65')).toBe(0.65)
    expect(parseTrueScale('?truescale=0')).toBe(0)
    expect(parseTrueScale('?truescale=-1')).toBe(0)
    expect(parseTrueScale('?truescale=5')).toBe(MAX_TRUESCALE)
    expect(MAX_TRUESCALE).toBe(0.7)
  })

  it('falls back to the default when unreadable', () => {
    for (const search of ['?truescale=abc', '?truescale=NaN', '?truescale=Infinity', '?truescale=-Infinity']) {
      expect(parseTrueScale(search), search).toBe(DEFAULT_TRUESCALE)
    }
  })

  it('is 0 outside a browser', () => {
    expect(TRUESCALE).toBe(0)
  })
})

describe('towardTrue', () => {
  it('is the scene radius itself at a = 0', () => {
    for (const scene of [10, 6.55, 1, 0.236]) expect(Object.is(towardTrue(scene, 322, 0), scene)).toBe(true)
    // The page's factor, 0 here, by default.
    expect(towardTrue(10, 322)).toBe(10)
  })

  it('is the true radius at a = 1 and the geometric mean at a = 0.5', () => {
    expect(towardTrue(10, 322, 1)).toBeCloseTo(322, 9)
    expect(towardTrue(10, 322, 0.5)).toBeCloseTo(Math.sqrt(10 * 322), 9)
    expect(towardTrue(1, 0.8, 0.5)).toBeCloseTo(Math.sqrt(0.8), 9)
  })
})
