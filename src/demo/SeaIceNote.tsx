// The note naming the sea ice's year (tides-6ru.1): whatever the sim date's
// year, the globe draws 2025's ice for its day of the year (sea-ice.ts
// seaIceDay), so the view says so while the ice is drawn (sea-ice-gate.ts
// seaIceNoteShown) and has loaded. It never asks for the ice itself: the
// globe does, after the first frame. Bottom-left over the view, above its
// label or the view menu (index.css .sea-ice-note).
import { useSeaIceTour } from './demo-aids'
import { useLoadedSeaIce } from './sea-ice-data'
import { seaIceNoteShown, type SeaIceView } from './sea-ice-gate'

/** Over the view that draws the globe, `view` as its SolarSystem is given it. */
export function SeaIceNote({ view }: { view: SeaIceView }) {
  const tour = useSeaIceTour()
  const data = useLoadedSeaIce()
  if (!data || !seaIceNoteShown(view, tour)) return null
  return <SeaIceNoteLine year={data.ice.year} />
}

export function SeaIceNoteLine({ year }: { year: number }) {
  return (
    <p
      className="sea-ice-note"
      data-sea-ice-note
    >
      Sea ice: {year} data
      <span className="visually-hidden"> (the globe shows {year}’s sea ice for this day of the year)</span>
    </p>
  )
}
