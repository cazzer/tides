// The focused planet's or moon's name at the top of the main view, with its
// diameter and a size to picture (tides-ufyr.18; the copy is body-facts.ts).
// It stands in for the body's own name in the scene, which BodyLabels hides
// while this shows. A DOM overlay in the main Panel (App.tsx), mounted with
// the planets on and the system view filling the 'main' grid area; nothing
// for Earth, the Moon, the Sun, the clock or a location.
import type { Ref } from 'react'
import { focusTitleFor, type FocusTitle as Title } from './body-facts'
import { useDemoChromeRef } from './demo/demo-chrome'
import { useStore } from './store'

export interface FocusTitleViewProps {
  title: Title
  chromeRef?: Ref<HTMLDivElement>
}

export function FocusTitleView({ title, chromeRef }: FocusTitleViewProps) {
  return (
    <div ref={chromeRef} className="focus-title">
      <p className="focus-title__name">{title.name}</p>
      <p className="focus-title__stats">
        <span className="focus-title__stat">{title.size}</span>
        <span className="focus-title__stat">{title.comparison}</span>
      </p>
    </div>
  )
}

export function FocusTitle() {
  const focus = useStore((s) => s.cameraFocus)
  // A demo box, so a tour frames its stop below the title and BodyLabels
  // keeps names out from under it. Registered outside the tours too: the
  // tours' framing (DemoPlayer) reads the boxes only while a demo runs, and
  // the names should clear the title either way.
  const chromeRef = useDemoChromeRef<HTMLDivElement>()
  const title = focusTitleFor(focus)
  return title ? <FocusTitleView title={title} chromeRef={chromeRef} /> : null
}
