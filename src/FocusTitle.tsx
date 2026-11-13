// The focused planet's or moon's name at the top of the main view, with its
// diameter and its size against Earth or our Moon on one short line
// (tides-ufyr.18; the copy is body-facts.ts).
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
      {/* A heading, not a live region: it changes with every focus, and the
          tours' captions already announce each stop. */}
      <h2 className="focus-title__name">{title.name}</h2>
      <p className="focus-title__stats">
        {title.size}
        {title.comparison && (
          <>
            {/* The spaces stay outside the hidden dot, so a reader still
                hears two words, not "km0.38". */}
            {' '}
            <span aria-hidden="true">·</span>
            {' '}
            {title.comparison}
          </>
        )}
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
