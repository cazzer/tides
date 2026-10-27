import { useEffect } from 'react'
import { shipAudio, type ShipAudio } from './ship-audio'

type Events = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

const CAPTURE = { capture: true, passive: true } as const

/**
 * Ship mode's sound while bound (tides-a4j.1): activates `audio`, unlocks it
 * on the first key or tap, and suspends it while `doc` is hidden. Returns the
 * cleanup, which deactivates it.
 */
export function bindShipAudio(
  audio: ShipAudio,
  win: Events,
  doc: Events & Pick<Document, 'visibilityState'>
): () => void {
  // Escape isn't a user activation (and leaves ship mode anyway). A touch's
  // pointerdown isn't one either, only its pointerup.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') audio.gesture()
  }
  const onPointer = () => audio.gesture()
  const onVisibilityChange = () => audio.setVisible(doc.visibilityState === 'visible')

  onVisibilityChange()
  audio.activate()

  // Capture phase: a handler that stops propagation still unlocks the sound.
  win.addEventListener('keydown', onKeyDown as EventListener, CAPTURE)
  win.addEventListener('pointerdown', onPointer, CAPTURE)
  win.addEventListener('pointerup', onPointer, CAPTURE)
  doc.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    win.removeEventListener('keydown', onKeyDown as EventListener, CAPTURE)
    win.removeEventListener('pointerdown', onPointer, CAPTURE)
    win.removeEventListener('pointerup', onPointer, CAPTURE)
    doc.removeEventListener('visibilitychange', onVisibilityChange)
    audio.deactivate()
  }
}

/** Ship mode's sound while the calling component is mounted. */
export function useShipAudio(): void {
  useEffect(() => bindShipAudio(shipAudio, window, document), [])
}
