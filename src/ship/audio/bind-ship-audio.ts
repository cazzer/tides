import { useEffect } from 'react'
import { shipAudio, type ShipAudio } from './ship-audio'

type Events = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

const CAPTURE = { capture: true, passive: true } as const

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

/**
 * Ship mode's sound while bound (tides-a4j.1): activates `audio`, unlocks it
 * on the first key or tap, suspends it while `doc` is hidden, and toggles the
 * mute on M. Returns the cleanup, which deactivates it.
 */
export function bindShipAudio(
  audio: ShipAudio,
  win: Events,
  doc: Events & Pick<Document, 'visibilityState' | 'querySelector'>
): () => void {
  // Escape isn't a user activation (and leaves ship mode anyway). A touch's
  // pointerdown isn't one either, only its pointerup.
  const onGestureKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') audio.gesture()
  }
  const onPointer = () => audio.gesture()
  const onVisibilityChange = () => audio.setVisible(doc.visibilityState === 'visible')

  // M, by position and with the guards of the flight keys and T
  // (ShipTargeting); bubbling, so a handler that took the key first wins.
  const onMuteKey = (event: KeyboardEvent) => {
    if (event.code !== 'KeyM' || event.repeat || event.defaultPrevented) return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (doc.querySelector('dialog[open]')) return
    const target = event.target as Element | null
    if (typeof target?.closest === 'function' && target.closest(EDITABLE_SELECTOR)) return
    event.preventDefault()
    audio.setMuted(!audio.isMuted())
  }

  onVisibilityChange()
  audio.activate()

  // Capture phase: a handler that stops propagation still unlocks the sound.
  win.addEventListener('keydown', onGestureKey as EventListener, CAPTURE)
  win.addEventListener('pointerdown', onPointer, CAPTURE)
  win.addEventListener('pointerup', onPointer, CAPTURE)
  win.addEventListener('keydown', onMuteKey as EventListener)
  doc.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    win.removeEventListener('keydown', onGestureKey as EventListener, CAPTURE)
    win.removeEventListener('pointerdown', onPointer, CAPTURE)
    win.removeEventListener('pointerup', onPointer, CAPTURE)
    win.removeEventListener('keydown', onMuteKey as EventListener)
    doc.removeEventListener('visibilitychange', onVisibilityChange)
    audio.deactivate()
  }
}

/** Ship mode's sound while the calling component is mounted. */
export function useShipAudio(): void {
  useEffect(() => bindShipAudio(shipAudio, window, document), [])
}
