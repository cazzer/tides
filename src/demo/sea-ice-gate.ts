// Where the globe draws the date's sea ice (tides-6ru.1): the one place it is
// decided. SeaIceGlobe's mount and the globe's clouds (solar-system.tsx) and
// the note naming the data's year (SeaIceNote.tsx) all read it. The ground
// draws the ice itself (../renderers/seaIceGround.ts, tides-6ru.2), in the
// main view and in ship mode; the floating shell only in the seasons tour,
// whose look it keeps. Pure, so tests can run it.

/** The view drawing the globe. */
export interface SeaIceView {
  /** The main view, the one with controls. */
  interactive: boolean
  /** From the surface, where the ground stands in for the globe. */
  earthCamera: boolean
  ship: boolean
}

/** The tour running, if any. */
export interface SeaIceTour {
  running: boolean
  /** The seasons tour's aids.seaIce (tides-zec.19). */
  seaIceAid: boolean
}

/**
 * Whether the view's globe may draw the date's sea ice, tour or not: the main
 * view's and ship mode's (whose Scene isn't `interactive`, tides-6ru.2). The
 * other panels never see the globe from outside (the Moon Phase camera sits
 * inside its shells), so they don't load or draw it. The ice's driver
 * (SeaIceGlobe) stays mounted here, so it isn't rebuilt on the way back from
 * a tour that has it off.
 */
export function seaIceMayShow(view: SeaIceView): boolean {
  return (view.interactive || view.ship) && !view.earthCamera
}

/**
 * Whether the seasons tour's floating shell is mounted (kept warm, shown
 * only in the tour): the main view's alone. Ship mode never loads its 7 MB
 * mask; the ground draws the ice there.
 */
export function seaIceShellMounts(view: SeaIceView): boolean {
  return view.interactive && !view.earthCamera && !view.ship
}

/**
 * Whether the view's globe draws the date's sea ice now. Every tour keeps
 * its own look, so of the tours only the seasons tour's aids.seaIce draws it.
 */
export function seaIceOnGlobe(view: SeaIceView, tour: SeaIceTour): boolean {
  return seaIceMayShow(view) && (!tour.running || tour.seaIceAid)
}

/**
 * Whether the globe's clouds give way to the ice: in the seasons tour only,
 * so the ice reads. Elsewhere they draw over it (SEA_ICE_RENDER_ORDER).
 */
export function seaIceHidesClouds(view: SeaIceView, tour: SeaIceTour): boolean {
  return tour.seaIceAid && seaIceOnGlobe(view, tour)
}

/**
 * Whether the note naming the data's year shows (once the ice has loaded):
 * wherever the globe draws the ice, ship mode too, but in the seasons tour,
 * whose readout dates its own polar maps.
 */
export function seaIceNoteShown(view: SeaIceView, tour: SeaIceTour): boolean {
  return !tour.running && seaIceOnGlobe(view, tour)
}
