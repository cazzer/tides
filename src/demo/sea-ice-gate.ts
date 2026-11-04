// Where the globe draws the date's sea ice (tides-6ru.1): the one place it is
// decided. SeaIceGlobe's mount and the globe's clouds (solar-system.tsx) and
// the note naming the data's year (SeaIceNote.tsx) all read it; the ship's
// view (tides-6ru.2) and the close-zoom tiles (tides-5oz) widen or follow it
// here. Pure, so tests can run it.

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
 * view's, out of ship mode for now (tides-6ru.2). The other panels never see
 * the globe from outside (the Moon Phase camera sits inside its shells), so
 * they don't load or draw it. The ice's shell stays mounted here, hidden
 * while a tour has it off, so it isn't rebuilt on the way back.
 */
export function seaIceMayShow(view: SeaIceView): boolean {
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
 * wherever the globe draws the ice but in the seasons tour, whose readout
 * dates its own polar maps.
 */
export function seaIceNoteShown(view: SeaIceView, tour: SeaIceTour): boolean {
  return !tour.running && seaIceOnGlobe(view, tour)
}
