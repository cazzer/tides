import { useRef } from 'react'
import styled from 'styled-components'
import { MouseJoystickWidget } from './MouseJoystickWidget'
import { useDesktopShipInput, type JoystickDisplay } from './useDesktopShipInput'

/**
 * Desktop flight controls for ship mode (tides-3bl.3): keyboard and the
 * mouse virtual joystick, with its widget. Mount once over the ship view;
 * the layer it renders fills the view and sets the joystick's centre.
 */
export function DesktopShipControls() {
  const area = useRef<HTMLDivElement>(null)
  const widget = useRef<JoystickDisplay>(null)
  useDesktopShipInput(area, widget)
  return (
    <Layer ref={area}>
      <MouseJoystickWidget ref={widget} />
    </Layer>
  )
}

const Layer = styled.div`
  position: absolute;
  inset: 0;
  pointer-events: none;
`
