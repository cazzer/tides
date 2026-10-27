import { useEffect, useRef } from 'react'
import { shipInput } from '../ship-input'
import { shipTelemetry } from '../ship-telemetry'
import { stepShipVoices, teardownShipVoices, type ShipVoices } from './ship-voices'
import { useShipAudioFrame } from './useShipAudioFrame'

/**
 * The ship's engine, thrusters, boost and wind (tides-a4j.2), from the
 * telemetry ShipController writes this frame: mount after it, in the ship
 * scene. Builds its voices on the first running frame and again for a new
 * context; takes them down on unmount.
 */
export function ShipSound() {
  const voices = useRef<ShipVoices | null>(null)

  useShipAudioFrame((out, dt) => {
    voices.current = stepShipVoices(voices.current, out, shipTelemetry, shipInput, dt)
  })

  useEffect(
    () => () => {
      if (voices.current) teardownShipVoices(voices.current)
      voices.current = null
    },
    []
  )

  return null
}
