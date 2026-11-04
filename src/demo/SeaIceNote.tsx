// The note naming the sea ice's year (tides-6ru.1): whatever the sim date's
// year, the globe draws 2025's ice for its day of the year (sea-ice.ts
// seaIceDay), so the main view says so while the ice is drawn
// (sea-ice-gate.ts seaIceNoteShown) and has loaded. It never asks for the
// ice itself: the globe does, after the first frame. Bottom-left over the
// view, above its label or the view menu (index.css .sea-ice-note).
import { useSeaIceTour } from './demo-aids'
import { useLoadedSeaIce } from './sea-ice-data'
import { seaIceNoteShown, type SeaIceView } from './sea-ice-gate'

// The main view (App.tsx mounts the note in its overlay).
const MAIN_VIEW: SeaIceView = { interactive: true, earthCamera: false, ship: false }

export function SeaIceNote() {
  const tour = useSeaIceTour()
  const data = useLoadedSeaIce()
  if (!data || !seaIceNoteShown(MAIN_VIEW, tour)) return null
  return <SeaIceNoteLine year={data.ice.year} />
}

export function SeaIceNoteLine({ year }: { year: number }) {
  return (
    <p
      className="sea-ice-note"
      data-sea-ice-note
    >
      Sea ice: {year} data
    </p>
  )
}
