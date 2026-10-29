import { PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { bandFraming, clearBand, type Rect } from './demo-chrome'
import { KEEP_MARGIN, keepDistance } from './demo-script'

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom })

describe('clearBand', () => {
  const desktop = rect(0, 0, 1440, 900)

  it('is the whole view with no boxes', () => {
    expect(clearBand(desktop, [])).toEqual({ top: 0, bottom: 900 })
  })

  it('ends above the caption, and ignores a readout in a desktop corner', () => {
    const caption = rect(317, 666, 1123, 888)
    const readout = rect(8, 8, 403, 216)
    expect(clearBand(desktop, [caption, readout])).toEqual({ top: 0, bottom: 658 })
  })

  it('runs between a phone’s readout and caption', () => {
    const phone = rect(0, 0, 390, 844)
    expect(clearBand(phone, [rect(8, 8, 382, 120), rect(8, 630, 382, 832)])).toEqual({ top: 128, bottom: 622 })
  })

  it('counts boxes in view px, for a view lower on the page', () => {
    expect(clearBand(rect(0, 100, 400, 900), [rect(0, 700, 400, 900)])).toEqual({ top: 0, bottom: 592 })
  })

  it('falls back to the whole view when the boxes leave a sliver', () => {
    const land = rect(0, 0, 844, 390)
    expect(clearBand(land, [rect(142, 214, 702, 378), rect(8, 8, 400, 150)])).toEqual({ top: 0, bottom: 390 })
  })
})

describe('bandFraming', () => {
  it('shifts the view’s centre to the band’s, with the band’s own field', () => {
    const { offsetY, vfov } = bandFraming({ top: 0, bottom: 600 }, 900, 50)
    expect(offsetY).toBe(150)
    expect(Math.tan((vfov * Math.PI) / 360)).toBeCloseTo((600 / 900) * Math.tan((25 * Math.PI) / 180))
    expect(bandFraming({ top: 0, bottom: 900 }, 900, 50)).toEqual({ offsetY: 0, vfov: 50 })
  })

  it('puts the target at the band’s centre on screen', () => {
    const height = 900
    const band = { top: 100, bottom: 600 }
    const camera = new PerspectiveCamera(50, 1440 / height, 0.1, 100)
    camera.setViewOffset(1440, height, 0, bandFraming(band, height, 50).offsetY, 1440, height)
    camera.position.set(0, 0, 10)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    const ndc = new Vector3(0, 0, 0).project(camera)
    const screenY = ((1 - ndc.y) / 2) * height
    expect(screenY).toBeCloseTo(350)
  })
})

describe('keepDistance', () => {
  const vfov = 50
  const tanV = KEEP_MARGIN * Math.tan((25 * Math.PI) / 180)

  it('is 0 with nothing kept', () => {
    expect(keepDistance([], new Vector3(0, 0, 1), vfov, 1)).toBe(0)
  })

  it('backs off until a body above the focus fits, its top edge just inside the view’s', () => {
    const body = { offset: new Vector3(0, 10, 0), radius: 1 }
    const distance = keepDistance([body], new Vector3(0, 0, 1), vfov, 2)
    expect(distance).toBeCloseTo(11 / tanV)
  })

  it('is set by the narrower half on a phone', () => {
    const aspect = 390 / 844
    const body = { offset: new Vector3(10, 0, 0), radius: 1 }
    expect(keepDistance([body], new Vector3(0, 0, 1), vfov, aspect)).toBeCloseTo(11 / (tanV * aspect))
  })

  it('counts a body toward the eye as nearer the edge', () => {
    const near = keepDistance([{ offset: new Vector3(0, 10, 5), radius: 1 }], new Vector3(0, 0, 1), vfov, 2)
    expect(near).toBeCloseTo(5 + 11 / tanV)
  })
})
