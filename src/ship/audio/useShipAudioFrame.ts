import { useFrame } from '@react-three/fiber'
import { MAX_DT } from '../flight'
import { shipAudio, type ShipAudio, type ShipAudioOutput } from './ship-audio'

export type ShipAudioUpdate = (out: ShipAudioOutput, dt: number) => void

/**
 * One frame of useShipAudioFrame: `update` only while the sound is running
 * (ShipAudio.isRunning, as for the cues), so not in the fade before a
 * suspend either; the master gain is fading then anyway.
 */
export function stepShipAudioFrame(update: ShipAudioUpdate, delta: number, audio: ShipAudio = shipAudio): void {
  const out = audio.output()
  if (out && audio.isRunning()) update(out, Math.min(delta, MAX_DT))
}

/**
 * Calls `update` every frame with the ship's sound output and the frame time,
 * capped like the flight step's, while the sound runs: not before the first
 * gesture, nor while muted, hidden or resuming. For voices driven by ship
 * state (tides-a4j.2), mounted in the ship scene. The output can change (a
 * closed context remade), so key voices by out.context.
 *
 * `priority` is useFrame's (ship-session.ts lists the ship's). At the default
 * 0 the update follows ShipController's step, also 0 and the writer of
 * shipTelemetry, only when mounted after it, as at ShipView's SHIP SCENE
 * MOUNT POINT: R3F runs equal priorities in subscription order.
 */
export function useShipAudioFrame(update: ShipAudioUpdate, priority = 0): void {
  useFrame((_, delta) => stepShipAudioFrame(update, delta), priority)
}
