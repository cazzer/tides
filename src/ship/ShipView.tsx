import { useEffect, useRef, useState, type ReactNode } from 'react'
import styled from 'styled-components'
import { PerspectiveCamera, View } from '@react-three/drei'
import { IconX } from '@tabler/icons-react'
import { useStore } from '../store'
import { glassFloatingButton } from '../glass-styles'
import { ShipController } from './ShipController'
import { DesktopShipControls } from './DesktopShipControls'
import { SpaceDust } from './SpaceDust'
import { SpeedFov } from './useSpeedFov'
import { ShipShake } from './useShipShake'
import { SpeedBlur } from './SpeedBlur'
import { ShipHud } from './ShipHud'
import { ShipTargeting } from './ShipTargeting'
import { ShipWarmup } from './ShipWarmup'
import { SurfaceCredit } from './SurfaceCredit'
import { SHIP_FAR, SHIP_FOV } from './ship-session'
import { TouchShipControls } from './TouchShipControls'
import { releaseFlightTextures } from '../renderers/useFlightTexture'
import { useShipAudio } from './audio/bind-ship-audio'
import { ShipSound } from './audio/ShipSound'
import { ShipCues } from './audio/ShipCues'

// After the exit has rendered, focus the ship button if the three-body view
// came back with one (it carries data-ship-button); otherwise focus falls to
// the page as usual.
function focusShipButton() {
  setTimeout(() =>
    document.querySelector<HTMLElement>('[data-ship-button]')?.focus({ preventScroll: true })
  )
}

const FILL = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
} as const

const ANNOUNCEMENT = 'Ship mode. Press Escape to exit.'
const ANNOUNCE_DELAY_MS = 100

/**
 * Ship mode's full-screen first-person view (tides-3bl). `children` is the
 * scene to fly through; App passes its Scene, which this module can't import
 * without a cycle. No OrbitControls are mounted, so the scene's
 * CameraProvider (which acts only through controls) leaves the camera to
 * ShipController.
 */
export function ShipView({ children }: { children: ReactNode }) {
  const exitShip = useStore((s) => s.exitShip)
  const exitButton = useRef<HTMLButtonElement>(null)
  const [announcement, setAnnouncement] = useState('')

  // A handler that consumes Escape itself (e.g. closing the controls modal)
  // calls preventDefault, which leaves ship mode alone.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) exitShip()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [exitShip])

  // Focus moves into the view on entry (the button that opened it is gone)
  // and back to the ship button, wherever it remounts, on the way out.
  useEffect(() => {
    exitButton.current?.focus({ preventScroll: true })
    // Screen readers pick up a live region's changes only once they have seen
    // it, so the text lands a moment after mount.
    const announce = setTimeout(() => setAnnouncement(ANNOUNCEMENT), ANNOUNCE_DELAY_MS)
    return () => {
      clearTimeout(announce)
      focusShipButton()
    }
  }, [])

  // The flight-only maps (tides-01v.6) last as long as the flight.
  useEffect(() => releaseFlightTextures, [])

  // Silent until the first key or tap, and outside ship mode (tides-a4j.1).
  useShipAudio()

  return (
    <div
      className="panel"
      data-area="main"
      style={{ gridArea: 'main' }}
      role="region"
      aria-label="Ship view"
    >
      <View style={FILL}>
        <PerspectiveCamera
          makeDefault
          fov={SHIP_FOV}
          near={0.01}
          far={SHIP_FAR}
        />
        <ShipController />
        {children}
        {/* SHIP SCENE MOUNT POINT: in-scene additions that need the ship
            camera or the R3F frame loop go here, e.g. space dust, the
            speed FOV kick (tides-3bl.6), the air shudder (tides-xxg) and
            the engine and wind sound (tides-a4j.2) and its one-shot cues
            (tides-a4j.3), which read what ShipController, SpeedFov and
            ShipTargeting write, so they come after them. */}
        <SpaceDust />
        <SpeedFov />
        <ShipShake />
        <ShipTargeting />
        <ShipWarmup />
        <ShipSound />
        <ShipCues />
      </View>
      {/* The speed blur (tides-5lj) right over the View, before every other
          overlay: no z-index, so the controls, HUD, exit button, credit,
          markers and impact flash stack above it and keep the pointer. */}
      <SpeedBlur />
      <ExitButton
        ref={exitButton}
        type="button"
        onClick={exitShip}
        aria-label="Exit ship mode"
        title="Exit ship mode (Esc)"
      >
        <IconX
          size={20}
          stroke={1.75}
        />
      </ExitButton>
      <VisuallyHidden role="status">{announcement}</VisuallyHidden>
      {/* SHIP OVERLAY MOUNT POINT: DOM overlays over the view go here, after
          the View so they stack above it:
          - the speed blur under boost, first, just after the View (tides-5lj)
          - desktop keyboard + virtual-joystick mouse input (tides-3bl.3)
          - touch steer stick and throttle/roll stick (tides-3bl.4, tides-2hv.3)
          - HUD, target lock and controls modal (tides-3bl.5) */}
      <DesktopShipControls />
      <TouchShipControls />
      <ShipHud />
      <SurfaceCredit />
    </div>
  )
}

// Exactly where the folded dock's toggle sits on a phone (centred in the
// dock-height circle at the dock's corner), so the control doesn't jump on
// entry; the dock is hidden here.
const EXIT_INSET = 'calc((var(--dock-height) - var(--dock-button-size, 40px)) / 2)'

const ExitButton = styled.button`
  ${glassFloatingButton}
  position: absolute;
  top: calc(var(--dock-top) + ${EXIT_INSET});
  left: calc(var(--dock-inset-left) + ${EXIT_INSET});
  z-index: 1;
`

const VisuallyHidden = styled.p`
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
`
