import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { playShipCue } from './ship-audio'
import {
  createShipCueWatch,
  readShipCueSignals,
  watchShipCues,
  type ShipCueKind,
  type ShipCueSignals,
  type ShipCueWatch,
} from './ship-cues'
import { SHIP_CUE_SOUNDS } from './cue-sounds'

const play = (kind: ShipCueKind) => playShipCue(SHIP_CUE_SOUNDS[kind])

/**
 * The ship's one-shot cues (tides-a4j.3): impact, approach klaxon, target
 * lock and Flight Assist. Mount after ShipController, SpeedFov (which counts
 * impacts) and ShipTargeting (which sets the approach), in the ship scene.
 * Watches every frame, sound or not, so what changed while muted or hidden
 * never sounds late; playShipCue drops cues while the sound isn't running.
 */
export function ShipCues() {
  const watch = useRef<ShipCueWatch | null>(null)
  const signals = useRef<ShipCueSignals | null>(null)

  useFrame(() => {
    watch.current ??= createShipCueWatch()
    signals.current ??= { impacts: 0, status: 'open', target: null, flightAssist: true }
    watchShipCues(watch.current, readShipCueSignals(signals.current), performance.now(), play)
  })

  return null
}
