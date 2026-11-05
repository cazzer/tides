import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { createGlowPass, type GlowPass as Pass } from './glow-pass'
import { glowOn } from './glowSources'

/**
 * Before drei's View draws (its useFrame runs at priority 1) and after the
 * bodies, cameras and controls have moved (priority 0 and below).
 */
export const GLOW_PREPARE_PRIORITY = 0.5
/** After every View has drawn. */
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
  useFrame((state) => pass.current?.prepare(state.gl, state.scene, state.camera, track), GLOW_PREPARE_PRIORITY)
  useFrame((state) => pass.current?.composite(state.gl), GLOW_COMPOSITE_PRIORITY)
  return null
}
