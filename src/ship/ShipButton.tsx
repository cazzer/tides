import styled from 'styled-components'
import { IconRocket } from '@tabler/icons-react'
import { useStore } from '../store'
import { glassFloatingButton, PHONE } from '../glass-styles'

/**
 * Enters ship mode (tides-3bl). Sits in the bottom-right of the three-body
 * view; mount it only while that view is in the 'main' grid area.
 */
export function ShipButton() {
  const enterShip = useStore((s) => s.enterShip)
  return (
    <Corner>
      <Button
        type="button"
        onClick={enterShip}
        aria-label="Fly the ship"
        title="Fly through the solar system"
      >
        <IconRocket
          size={20}
          stroke={1.75}
        />
      </Button>
    </Corner>
  )
}

// Level with the panel label in the opposite corner, clear of the dock. On a
// phone's triple layout the three-body view sits above the other two, so its
// bottom edge is mid-screen and needs no safe-area or dock clearance (as for
// the label in index.css).
const Corner = styled.div`
  position: absolute;
  right: var(--dock-inset-right);
  bottom: var(--dock-clearance);
  z-index: 1;

  ${PHONE} {
    .viewports:not(.viewports--single) > .panel[data-area='main'] > & {
      bottom: 6px;
    }
  }
`

const Button = styled.button`
  ${glassFloatingButton}
`
