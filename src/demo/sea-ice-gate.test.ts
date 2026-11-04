import { describe, expect, it } from 'vitest'
import { seaIceHidesClouds, seaIceMayShow, seaIceNoteShown, seaIceOnGlobe, seaIceShellMounts, type SeaIceTour, type SeaIceView } from './sea-ice-gate'

const main: SeaIceView = { interactive: true, earthCamera: false, ship: false }
const free: SeaIceTour = { running: false, seaIceAid: false }
const seasonsTour: SeaIceTour = { running: true, seaIceAid: true }
const otherTour: SeaIceTour = { running: true, seaIceAid: false }
// Ship mode's Scene, as App mounts it (not interactive).
const ship: SeaIceView = { interactive: false, earthCamera: false, ship: true }

describe('seaIceOnGlobe', () => {
  it('draws the ice on the main view outside the tours', () => {
    expect(seaIceOnGlobe(main, free)).toBe(true)
  })

  it('draws it in the seasons tour, and in no other tour', () => {
    expect(seaIceOnGlobe(main, seasonsTour)).toBe(true)
    expect(seaIceOnGlobe(main, otherTour)).toBe(false)
  })

  it('leaves out the other panels and the surface camera', () => {
    for (const tour of [free, seasonsTour]) {
      expect(seaIceOnGlobe({ ...main, interactive: false }, tour)).toBe(false)
      expect(seaIceOnGlobe({ ...main, earthCamera: true }, tour)).toBe(false)
    }
  })

  it('draws it in ship mode (tides-6ru.2)', () => {
    expect(seaIceOnGlobe(ship, free)).toBe(true)
    expect(seaIceOnGlobe({ ...ship, earthCamera: true }, free)).toBe(false)
  })
})

describe('seaIceMayShow', () => {
  it('keeps the shell on the main view whatever the tour, so a tour only hides it', () => {
    expect(seaIceMayShow(main)).toBe(true)
    for (const tour of [free, seasonsTour, otherTour]) {
      if (seaIceOnGlobe(main, tour)) expect(seaIceMayShow(main)).toBe(true)
    }
    expect(seaIceMayShow(ship)).toBe(true)
    expect(seaIceMayShow({ ...main, interactive: false })).toBe(false)
  })
})

describe('seaIceShellMounts', () => {
  it('mounts the tour\'s shell on the main view only, never in ship mode', () => {
    expect(seaIceShellMounts(main)).toBe(true)
    expect(seaIceShellMounts(ship)).toBe(false)
    expect(seaIceShellMounts({ ...main, ship: true })).toBe(false)
    expect(seaIceShellMounts({ ...main, interactive: false })).toBe(false)
    expect(seaIceShellMounts({ ...main, earthCamera: true })).toBe(false)
  })
})

describe('seaIceHidesClouds', () => {
  it('hides the clouds only in the seasons tour', () => {
    expect(seaIceHidesClouds(main, seasonsTour)).toBe(true)
    expect(seaIceHidesClouds(main, free)).toBe(false)
    expect(seaIceHidesClouds(main, otherTour)).toBe(false)
  })

  it('never where the ice isn’t drawn', () => {
    expect(seaIceHidesClouds({ ...main, earthCamera: true }, seasonsTour)).toBe(false)
    expect(seaIceHidesClouds({ ...main, interactive: false }, seasonsTour)).toBe(false)
  })
})

describe('seaIceNoteShown', () => {
  it('names the data’s year wherever the ice is drawn outside the tours', () => {
    expect(seaIceNoteShown(main, free)).toBe(true)
    expect(seaIceNoteShown(ship, free)).toBe(true)
    expect(seaIceNoteShown({ ...main, interactive: false }, free)).toBe(false)
  })

  it('leaves the seasons tour to its own readout', () => {
    expect(seaIceNoteShown(main, seasonsTour)).toBe(false)
    expect(seaIceNoteShown(main, otherTour)).toBe(false)
  })
})
