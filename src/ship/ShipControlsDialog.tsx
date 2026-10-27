import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react'
import styled from 'styled-components'
import { IconX } from '@tabler/icons-react'

const COARSE_POINTER = '(pointer: coarse)'

function prefersTouch(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(COARSE_POINTER).matches === true
}

// Before the rows, which use it at module load.
const Key = styled.kbd`
  display: inline-block;
  min-width: 22px;
  padding: 1px 5px;
  font-family: inherit;
  font-size: 12px;
  text-align: center;
  color: #ddd;
  background-color: #262626;
  border: 1px solid #3a3a3a;
  border-bottom-width: 2px;
  border-radius: 5px;
`

const KEYBOARD_ROWS: readonly [ReactNode, string][] = [
  ['Mouse', 'Bring the pointer to the centre, then move away from it to turn: further is faster'],
  [
    <>
      <Key>W</Key> <Key>S</Key>
    </>,
    'Throttle up and down. It stays set; S stops at zero, press again to reverse',
  ],
  [<Key>X</Key>, 'Zero throttle'],
  [
    <>
      <Key>A</Key> <Key>D</Key>
    </>,
    'Slide left and right',
  ],
  [
    <>
      <Key>R</Key> <Key>F</Key>
    </>,
    'Slide up and down',
  ],
  [
    <>
      <Key>Q</Key> <Key>E</Key>
    </>,
    'Roll left and right',
  ],
  [<Key>L</Key>, 'Hold to level out'],
  [<Key>Shift</Key>, "Hold to fly faster low in Earth's air"],
  [<Key>Z</Key>, 'Flight assist on or off'],
  [<Key>M</Key>, 'Sound on or off'],
  [<Key>T</Key>, "Target what's nearest the centre; press again for the next"],
  ['Click a planet', 'Target it'],
  [<Key>Esc</Key>, 'Leave the ship'],
]

const TOUCH_ROWS: readonly [ReactNode, string][] = [
  ['Left stick', 'Steer: push up to pitch the nose up, sideways to turn'],
  [
    'Right stick',
    'Push up or down to change the throttle; it holds when you let go. It stops at zero: keep pulling, or let go and pull again, to reverse. Tap the stick to cut the throttle. Left or right to roll',
  ],
  ['Bolt button (by the right stick)', "Hold to fly faster low in Earth's air"],
  [
    'Flight assist (top bar)',
    'Tap to switch: on, the ship slows and straightens itself; off, it drifts',
  ],
  ['Tap a planet', 'Target it'],
  ['×', 'Leave the ship'],
]

/**
 * How to fly, for the device in hand (tides-3bl.5): touch controls on a
 * coarse pointer, else keyboard and mouse. A native modal dialog, like the
 * settings dialog: showModal() supplies the focus trap and focus return.
 */
export function ShipControlsDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const pressedBackdrop = useRef(false)
  const done = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const touch = prefersTouch()

  // A backdrop press must start and end within one opening.
  const close = useCallback(() => {
    pressedBackdrop.current = false
    onClose()
  }, [onClose])

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      // The main action, not the close button showModal() picks first.
      done.current?.focus()
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Escape closes the dialog only. The capture phase runs before ShipView's
  // window listener, which skips a defaultPrevented Escape instead of exiting.
  // A key held from opening the dialog repeats into it: ignore it rather than
  // let it press a button.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      } else if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [open, close])

  const isBackdrop = (e: React.MouseEvent) => e.target === e.currentTarget

  return (
    <Dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={close}
      onMouseDown={(e) => {
        pressedBackdrop.current = isBackdrop(e)
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && isBackdrop(e)) close()
      }}
    >
      <Body>
        <Header>
          <Title id={titleId}>How to fly</Title>
          <CloseButton
            type="button"
            onClick={close}
            aria-label="Close"
          >
            <IconX
              size={18}
              stroke={2}
            />
          </CloseButton>
        </Header>
        <Intro>
          Speed scales with distance: the further you are from everything, the
          faster you go, up to many times c (c = speed of light). Lock a target
          and you slow down as you arrive. Flight assist, on to start, slows
          and straightens the ship when you let go; off, it drifts.
        </Intro>
        <Table>
          <tbody>
            {(touch ? TOUCH_ROWS : KEYBOARD_ROWS).map(([control, action]) => (
              <tr key={action}>
                <th scope="row">{control}</th>
                <td>{action}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Done
          ref={done}
          type="button"
          onClick={close}
        >
          Fly
        </Done>
      </Body>
    </Dialog>
  )
}

// Styled as the settings dialog (controls.tsx).
const Dialog = styled.dialog`
  width: min(400px, calc(100vw - 32px));
  /* Keep clear of the notch and home indicator in a landscape phone. */
  max-height: calc(
    100dvh - 32px - env(safe-area-inset-top) - env(safe-area-inset-bottom)
  );
  padding: 0;
  background-color: #1a1a1a;
  color: #aaa;
  border: 1px solid #333;
  border-radius: 12px;

  &::backdrop {
    background-color: rgba(0, 0, 0, 0.6);
  }
`

const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 20px 20px;
`

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
`

const Title = styled.h2`
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #ddd;
`

const CloseButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  background: transparent;
  color: gray;
  border: none;
  border-radius: 8px;
  cursor: pointer;

  &:hover {
    background-color: #222;
    color: #aaa;
  }

  &:focus-visible {
    outline: 2px solid #4c9ffe;
    outline-offset: 1px;
  }
`

const Intro = styled.p`
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  color: #999;
`

const Table = styled.table`
  border-collapse: collapse;
  font-size: 13px;
  line-height: 1.35;

  th,
  td {
    padding: 6px 0;
    vertical-align: top;
    border-top: 1px solid #2a2a2a;
  }

  tr:first-child th,
  tr:first-child td {
    border-top: none;
  }

  th {
    padding-right: 16px;
    font-weight: 500;
    color: #ddd;
    text-align: left;
    width: 36%;
  }
`

const Done = styled.button`
  align-self: flex-end;
  min-width: 88px;
  height: 36px;
  padding: 0 16px;
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  color: #111;
  background-color: #ddd;
  border: none;
  border-radius: 999px;
  cursor: pointer;

  &:hover {
    background-color: #fff;
  }

  &:focus-visible {
    outline: 2px solid #4c9ffe;
    outline-offset: 2px;
  }
`
