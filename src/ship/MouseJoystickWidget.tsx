import { useImperativeHandle, useRef, type Ref } from 'react'
import styled from 'styled-components'
import { JOYSTICK_DEAD_ZONE, JOYSTICK_SATURATION } from './mouse-joystick'
import type { JoystickDisplay } from './useDesktopShipInput'

/** On-screen radius of the saturation ring, px. The widget is a scale model. */
const RING_RADIUS = 44
const DEAD_ZONE_RADIUS = (RING_RADIUS * JOYSTICK_DEAD_ZONE) / JOYSTICK_SATURATION
const DOT_SIZE = 7

/**
 * The mouse virtual joystick's indicator (tides-3bl.3), centred in the ship
 * view: a faint ring for full turn rate, a small circle for the dead zone, and
 * a dot at the cursor's offset scaled into the ring, like Elite Dangerous's.
 * Drawn imperatively through `ref` at pointer rate, never through React state.
 * Starts hidden; the input binding shows it once a mouse is in play.
 */
export function MouseJoystickWidget({ ref }: { ref: Ref<JoystickDisplay> }) {
  const root = useRef<HTMLDivElement>(null)
  const dot = useRef<HTMLDivElement>(null)

  useImperativeHandle(
    ref,
    () => ({
      setVisible(visible) {
        const value = visible ? 'true' : 'false'
        if (root.current && root.current.dataset.visible !== value) {
          root.current.dataset.visible = value
        }
      },
      draw(x, y, active) {
        if (!root.current || !dot.current) return
        dot.current.style.transform = `translate(${x * RING_RADIUS}px, ${y * RING_RADIUS}px)`
        root.current.dataset.active = active ? 'true' : 'false'
      },
    }),
    []
  )

  return (
    <Root
      ref={root}
      aria-hidden="true"
      data-visible="false"
      data-active="false"
    >
      <DeadZone />
      <Dot ref={dot} />
    </Root>
  )
}

const Root = styled.div`
  position: absolute;
  top: 50%;
  left: 50%;
  width: ${RING_RADIUS * 2}px;
  height: ${RING_RADIUS * 2}px;
  margin: ${-RING_RADIUS}px 0 0 ${-RING_RADIUS}px;
  box-sizing: border-box;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 50%;
  pointer-events: none;
  opacity: 0;
  transition: opacity 200ms ease;

  &[data-visible='true'] {
    opacity: 1;
  }
`

const DeadZone = styled.div`
  position: absolute;
  top: 50%;
  left: 50%;
  width: ${DEAD_ZONE_RADIUS * 2}px;
  height: ${DEAD_ZONE_RADIUS * 2}px;
  margin: ${-DEAD_ZONE_RADIUS}px 0 0 ${-DEAD_ZONE_RADIUS}px;
  box-sizing: border-box;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 50%;
`

const Dot = styled.div`
  position: absolute;
  top: 50%;
  left: 50%;
  width: ${DOT_SIZE}px;
  height: ${DOT_SIZE}px;
  margin: ${-DOT_SIZE / 2}px 0 0 ${-DOT_SIZE / 2}px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.4);
  will-change: transform;

  [data-active='true'] > & {
    background: rgba(255, 255, 255, 0.9);
    box-shadow: 0 0 6px rgba(140, 190, 255, 0.8);
  }
`
