import { useEffect, useState } from 'react'
import styled from 'styled-components'
import { IconCompass } from '@tabler/icons-react'
import { useStore } from './store'
import { clampLook } from './sky-look'
import { compassSupported, followDeviceOrientation, requestOrientation } from './compass-follow'
import { glassButton, glassPanel } from './glass-styles'

// How long a hint (no sensor, access denied) stays up, in ms.
const HINT_MS = 3000

// Leaves compass mode with the view where it was, levelled and back in the
// drag's range.
function stopCompass() {
  useStore.setState((s) => ({ compass: false, skyLook: s.skyLook && clampLook(s.skyLook) }))
}

/**
 * Compass mode for View from Earth (tides-d5j): a quiet button in the
 * bottom-right that, while pressed, turns the view to wherever the phone's
 * back points. Mount it only while View from Earth fills the single layout;
 * unmounting turns compass mode off. Hidden where there is no sensor to read.
 */
export default function CompassButton() {
  const [supported] = useState(compassSupported)
  const active = useStore((s) => s.compass)
  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    return followDeviceOrientation(
      (look) => {
        // A drag may have taken over before this effect's cleanup runs.
        if (useStore.getState().compass) useStore.setState({ skyLook: look })
      },
      () => {
        stopCompass()
        setHint('No compass found on this device')
      }
    )
  }, [active])

  useEffect(
    () => () => {
      if (useStore.getState().compass) stopCompass()
    },
    []
  )

  useEffect(() => {
    if (!hint) return
    const timer = setTimeout(() => setHint(null), HINT_MS)
    return () => clearTimeout(timer)
  }, [hint])

  if (!supported) return null

  const toggle = () => {
    if (active) {
      stopCompass()
      return
    }
    setHint(null)
    void requestOrientation().then((granted) => {
      if (granted) useStore.setState({ compass: true })
      else setHint('Motion access was not allowed')
    })
  }

  return (
    <Corner>
      <Hint role="status">{hint}</Hint>
      <Button
        type="button"
        onClick={toggle}
        aria-pressed={active}
        aria-label="Compass"
        title={active ? 'Stop following the phone' : 'Point the phone at the sky to look around'}
      >
        <IconCompass
          size={20}
          stroke={1.75}
        />
      </Button>
    </Corner>
  )
}

// Level with the view menu in the opposite corner, clear of the dock.
const Corner = styled.div`
  position: absolute;
  right: var(--dock-inset-right);
  bottom: var(--dock-clearance);
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: none;
`

const Button = styled.button`
  ${glassButton}
  ${glassPanel}
  pointer-events: auto;
  color: rgba(255, 255, 255, 0.6);
  transition:
    background-color 120ms ease,
    color 120ms ease,
    border-color 200ms ease,
    box-shadow 200ms ease;

  &[aria-pressed='true'] {
    color: #fff;
    border-color: rgba(120, 180, 255, 0.75);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.18),
      0 0 14px 2px rgba(76, 159, 254, 0.55);
  }
`

// A live region, kept mounted so screen readers announce what lands in it.
const Hint = styled.p`
  ${glassPanel}
  margin: 0;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.85);

  &:empty {
    display: none;
  }
`
