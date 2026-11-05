import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { createGlowPass, type GlowPass as Pass } from './glow-pass'
import { glowOn } from './glowSources'

/**
 * Before drei's View draws (its useFrame runs at priority 1) and after the
 * camera's last move for the frame: the ship's settle on the ground
 * (SHIP_SETTLE_PRIORITY, 0.75), its shake (SHIP_SHAKE_PRIORITY, 0.9) and the
 * sky view's draw (AtmosphereRenderer's SKY_VIEW_PRIORITY, 0.9). Drawn any
 * earlier, the halos would be off their sources by the shake.
 */
export const GLOW_PREPARE_PRIORITY = 0.95
/**
 * After every View has drawn. Below PANEL_COPY_PRIORITY (../../panel-rate.ts),
 * which must stay the last frame callback: the side panels' copy takes their
 * final pixels.
 */
export const GLOW_COMPOSITE_PRIORITY = 2

/**
 * The selective glow (tides-64u, ./glow.ts) of the View it is mounted in:
 * what its scene's sources registered, blurred and added over the View.
 * Mount once inside a drei View (the main panel, the ship). Nothing on the
 * low tier.
 */
export function GlowPass() {
  return glowOn() ? <GlowPassOn /> : null
}

function GlowPassOn() {
  const track = useThree((s) => s.events.connected as Element | undefined)
  // Owned by the effect, not a memo: StrictMode's replayed effect would
  // otherwise dispose the one pass the frame loop goes on drawing with.
  const pass = useRef<Pass | null>(null)
  useEffect(() => {
    const created = createGlowPass()
    pass.current = created
    return () => {
      if (pass.current === created) pass.current = null
      created.dispose()
    }
  }, [])
  // The canvas's box as drei's View reads it (the root's size), so the glow
  // lands on the View's own pixels, with no layout read of the canvas.
  useFrame(
    (state) => pass.current?.prepare(state.gl, state.scene, state.camera, track, state.previousRoot?.getState().size ?? state.size),
    GLOW_PREPARE_PRIORITY
  )
  useFrame((state) => pass.current?.composite(state.gl), GLOW_COMPOSITE_PRIORITY)
  return null
}
