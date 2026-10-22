import { useEffect, type ReactNode } from 'react'
import styled from 'styled-components'
import { PerspectiveCamera, View } from '@react-three/drei'
import { IconX } from '@tabler/icons-react'
import { useStore } from '../store'
import { glassFloatingButton } from '../glass-styles'
import { ShipController } from './ShipController'
import { SHIP_FAR, SHIP_FOV } from './ship-session'

const FILL = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
} as const

/**
 * Ship mode's full-screen first-person view (tides-3bl). `children` is the
 * scene to fly through; App passes its Scene, which this module can't import
 * without a cycle. No OrbitControls are mounted, so the scene's
 * CameraProvider (which acts only through controls) leaves the camera to
 * ShipController.
 */
export function ShipView({ children }: { children: ReactNode }) {
  const exitShip = useStore((s) => s.exitShip)

  // A handler that consumes Escape itself (e.g. closing the controls modal)
  // calls preventDefault, which leaves ship mode alone.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) exitShip()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [exitShip])

  return (
    <div
      className="panel"
      data-area="main"
      style={{ gridArea: 'main' }}
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
            camera or the R3F frame loop go here, e.g. space dust and the
            speed FOV kick (tides-3bl.6). */}
      </View>
      <ExitButton
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
      {/* SHIP OVERLAY MOUNT POINT: DOM overlays over the view go here, after
          the View so they stack above it:
          - desktop keyboard + virtual-joystick mouse input (tides-3bl.3)
          - touch steer stick, throttle/roll slider, level button (tides-3bl.4)
          - HUD, target lock and controls modal (tides-3bl.5) */}
    </div>
  )
}

// Where the folded dock's button sits on a phone; the dock is hidden here.
const ExitButton = styled.button`
  ${glassFloatingButton}
  position: absolute;
  top: var(--dock-top);
  left: var(--dock-inset-left);
  z-index: 1;
`
