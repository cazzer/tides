import { useFrame } from '@react-three/fiber'
import { MAX_DT } from '../flight'
import { shipAudio, type ShipAudio, type ShipAudioOutput } from './ship-audio'

export type ShipAudioUpdate = (out: ShipAudioOutput, dt: number) => void

/** One frame of useShipAudioFrame: `update` only once there is sound to drive. */
export function stepShipAudioFrame(update: ShipAudioUpdate, delta: number, audio: ShipAudio = shipAudio): void {
  const out = audio.output()
  if (out) update(out, Math.min(delta, MAX_DT))
}

/**
 * Calls `update` every frame with the ship's sound output and the frame time,
 * capped like the flight step's; skipped until the first gesture has made the
 * context. For voices driven by ship state (tides-a4j.2), mounted in the ship
 * scene. The output can change (a closed context remade), so key voices by
 * out.context.
 */
export function useShipAudioFrame(update: ShipAudioUpdate): void {
  useFrame((_, delta) => stepShipAudioFrame(update, delta))
}
