import { useImperativeHandle, useRef, type Ref } from 'react'
import styled from 'styled-components'
import { JOYSTICK_DEAD_ZONE, JOYSTICK_SATURATION } from './mouse-joystick'
import type { JoystickDisplay } from './useDesktopShipInput'

/** On-screen radius of the saturation ring, px. The widget is a scale model. */
const RING_RADIUS = 44
const DEAD_ZONE_RADIUS = (RING_RADIUS * JOYSTICK_DEAD_ZONE) / JOYSTICK_SATURATION
const DOT_SIZE = 7

// A thin dark edge keeps the faint white strokes legible over a lit planet.
const HALO = 'rgba(0, 0, 0, 0.35)'

/**
 * The mouse virtual joystick's indicator (tides-3bl.3), centred in the ship
 * view: a faint ring for full turn rate, a small circle for the dead zone, and
 * a dot at the cursor's offset scaled into the ring, like Elite Dangerous's.
 * While unarmed the dot dims and the dead zone brightens: steering starts once
 * the cursor has been to the centre. Drawn imperatively through `ref` at
 * pointer rate, never through React state. Starts hidden; the input binding
 * shows it once a mouse is in play.
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
      draw(x, y, mode) {
        if (!root.current || !dot.current) return
        dot.current.style.transform = `translate(${x * RING_RADIUS}px, ${y * RING_RADIUS}px)`
        if (root.current.dataset.mode !== mode) root.current.dataset.mode = mode
      },
    }),
    []
  )

  return (
    <Root
      ref={root}
      aria-hidden="true"
      data-visible="false"
      data-mode="unarmed"
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
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  box-shadow:
    0 0 0 1px ${HALO},
    inset 0 0 0 1px ${HALO};
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
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 50%;
  box-shadow:
    0 0 0 1px ${HALO},
    inset 0 0 0 1px ${HALO};
  transition: border-color 200ms ease;

  [data-mode='unarmed'] > & {
    border-color: rgba(255, 255, 255, 0.75);
  }
`

const Dot = styled.div`
  position: absolute;
  top: 50%;
  left: 50%;
  width: ${DOT_SIZE}px;
  height: ${DOT_SIZE}px;
  margin: ${-DOT_SIZE / 2}px 0 0 ${-DOT_SIZE / 2}px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.55);
  box-shadow: 0 0 0 1px ${HALO};
  will-change: transform;

  [data-mode='unarmed'] > & {
    background: rgba(255, 255, 255, 0.25);
  }

  [data-mode='steering'] > & {
    background: rgba(255, 255, 255, 0.95);
    box-shadow:
      0 0 0 1px ${HALO},
      0 0 6px rgba(140, 190, 255, 0.8);
  }
`
