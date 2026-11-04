import { describe, expect, it } from 'vitest'
import { seaIceHidesClouds, seaIceNoteShown, seaIceOnGlobe, type SeaIceTour, type SeaIceView } from './sea-ice-gate'

const main: SeaIceView = { interactive: true, earthCamera: false, ship: false }
const free: SeaIceTour = { running: false, seaIceAid: false }
const seasonsTour: SeaIceTour = { running: true, seaIceAid: true }
const otherTour: SeaIceTour = { running: true, seaIceAid: false }

describe('seaIceOnGlobe', () => {
  it('draws the ice on the main view outside the tours', () => {
    expect(seaIceOnGlobe(main, free)).toBe(true)
  })

  it('draws it in the seasons tour, and in no other tour', () => {
    expect(seaIceOnGlobe(main, seasonsTour)).toBe(true)
    expect(seaIceOnGlobe(main, otherTour)).toBe(false)
  })

  it('leaves out the other panels, the surface camera and ship mode', () => {
    for (const tour of [free, seasonsTour]) {
      expect(seaIceOnGlobe({ ...main, interactive: false }, tour)).toBe(false)
      expect(seaIceOnGlobe({ ...main, earthCamera: true }, tour)).toBe(false)
      expect(seaIceOnGlobe({ ...main, ship: true }, tour)).toBe(false)
    }
  })
})

describe('seaIceHidesClouds', () => {
  it('hides the clouds only in the seasons tour', () => {
    expect(seaIceHidesClouds(main, seasonsTour)).toBe(true)
    expect(seaIceHidesClouds(main, free)).toBe(false)
    expect(seaIceHidesClouds(main, otherTour)).toBe(false)
  })

  it('never where the ice isn’t drawn', () => {
    expect(seaIceHidesClouds({ ...main, ship: true }, seasonsTour)).toBe(false)
    expect(seaIceHidesClouds({ ...main, interactive: false }, seasonsTour)).toBe(false)
  })
})

describe('seaIceNoteShown', () => {
  it('names the data’s year wherever the ice is drawn outside the tours', () => {
    expect(seaIceNoteShown(main, free)).toBe(true)
    expect(seaIceNoteShown({ ...main, ship: true }, free)).toBe(false)
  })

  it('leaves the seasons tour to its own readout', () => {
    expect(seaIceNoteShown(main, seasonsTour)).toBe(false)
    expect(seaIceNoteShown(main, otherTour)).toBe(false)
  })
})
