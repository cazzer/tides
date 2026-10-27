import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { shipApproach } from '../approach'
import { shipImpacts } from '../impact'
import { shipInput } from '../ship-input'
import { getShipTarget } from '../ship-telemetry'
import { playShipCue } from './ship-audio'
import { createShipCueWatch, watchShipCues, type ShipCueKind, type ShipCueSignals } from './ship-cues'
import { SHIP_CUE_SOUNDS } from './cue-sounds'

const play = (kind: ShipCueKind) => void playShipCue(SHIP_CUE_SOUNDS[kind])

/**
 * The ship's one-shot cues (tides-a4j.3): impact, approach klaxon, target
 * lock and Flight Assist. Mount after ShipController, useSpeedFov (which
 * counts impacts) and ShipTargeting (which sets the approach), in the ship
 * scene. Watches every frame, sound or not, so what changed while muted or
 * hidden never sounds late; playShipCue drops cues while the sound isn't
 * running.
 */
export function ShipCues() {
  const watch = useRef(createShipCueWatch())
  const signals = useRef<ShipCueSignals>({
    impacts: 0,
    subject: null,
    status: 'open',
    target: null,
    flightAssist: true,
  })

  useFrame(() => {
    const s = signals.current
    s.impacts = shipImpacts.count
    s.subject = shipApproach.key
    s.status = shipApproach.status
    s.target = getShipTarget()
    s.flightAssist = shipInput.flightAssist
    watchShipCues(watch.current, s, performance.now(), play)
  })

  return null
}
