import { useEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import { IconCompass } from '@tabler/icons-react'
import { useStore } from './store'
import { clampLook } from './sky-look'
import { compassSupported, followDeviceOrientation, requestOrientation } from './compass-follow'
import { glassButton, glassPanel } from './glass-styles'

// How long a hint stays up, in ms.
const HINT_MS = 5000

const HINTS = {
  start: 'Hold your phone up to the sky',
  'no-sensor': 'No motion sensor found on this device',
  'no-north': 'Couldn’t find north from the compass',
  denied: 'Allow motion access in Settings to use the compass',
}

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
  // The last hint stays in place while it fades out.
  const [hint, setHint] = useState<keyof typeof HINTS | null>(null)
  const [hintShown, setHintShown] = useState(false)
  const showHint = (key: keyof typeof HINTS) => {
    setHint(key)
    setHintShown(true)
  }
  const mounted = useRef(false)

  useEffect(() => {
    if (!active) return
    return followDeviceOrientation(
      (look) => {
        // A drag may have taken over before this effect's cleanup runs.
        if (useStore.getState().compass) useStore.setState({ skyLook: look })
      },
      (silence) => {
        stopCompass()
        showHint(silence)
      }
    )
  }, [active])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (useStore.getState().compass) stopCompass()
    }
  }, [])

  useEffect(() => {
    if (!hintShown) return
    const timer = setTimeout(() => setHintShown(false), HINT_MS)
    return () => clearTimeout(timer)
  }, [hint, hintShown])

  if (!supported) return null

  const toggle = () => {
    if (active) {
      stopCompass()
      return
    }
    setHintShown(false)
    void requestOrientation().then((granted) => {
      // The view may have changed while the permission prompt was up.
      if (!mounted.current) return
      if (granted) useStore.setState({ compass: true })
      showHint(granted ? 'start' : 'denied')
    })
  }

  return (
    <Corner>
      <Hint
        role="status"
        $shown={hintShown}
      >
        {hint && HINTS[hint]}
      </Hint>
      <Button
        type="button"
        onClick={toggle}
        aria-pressed={active}
        aria-label="Compass mode"
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
`

const Button = styled.button`
  ${glassButton}
  ${glassPanel}
  position: relative;
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

  /* A 48px tap target around the 40px disc. */
  &::before {
    content: '';
    position: absolute;
    inset: -4px;
  }

  /* Touch keeps :hover after a tap, which would make "off" look on. */
  @media (hover: none) {
    &:hover {
      background-color: rgba(30, 30, 34, 0.55);
      color: rgba(255, 255, 255, 0.6);
    }

    &[aria-pressed='true']:hover {
      color: #fff;
    }
  }

  /* White, so focus doesn't read as the blue "on" glow. */
  &:focus-visible {
    outline-color: #fff;
    outline-offset: 3px;
  }
`

// Above the button, clear of the view menu on a narrow phone. A live region
// kept in the accessibility tree, so screen readers announce what lands in it.
const Hint = styled.p<{ $shown: boolean }>`
  ${glassPanel}
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  width: max-content;
  max-width: calc(100vw - 2 * var(--dock-inset-right));
  margin: 0;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.85);
  pointer-events: none;
  opacity: ${(p) => (p.$shown ? 1 : 0)};
  transition: opacity 200ms ease;
`
