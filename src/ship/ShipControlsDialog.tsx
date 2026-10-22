import { useEffect, useId, useRef, type ReactNode } from 'react'
import styled from 'styled-components'
import { IconX } from '@tabler/icons-react'
import { shipInput } from './ship-input'

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
  ['Mouse', 'Steer: move away from the centre to turn'],
  [<><Key>W</Key> <Key>S</Key></>, 'Throttle up and down (it stays set)'],
  [<Key>X</Key>, 'Zero throttle'],
  [<><Key>A</Key> <Key>D</Key></>, 'Slide left and right'],
  [<><Key>R</Key> <Key>F</Key></>, 'Slide up and down'],
  [<><Key>Q</Key> <Key>E</Key></>, 'Roll left and right'],
  [<Key>L</Key>, 'Level out (hold)'],
  [<Key>Z</Key>, 'Flight assist on or off'],
  [<>Click a planet or <Key>T</Key></>, 'Lock a target'],
  [<Key>Esc</Key>, 'Leave the ship'],
]

const TOUCH_ROWS: readonly [ReactNode, string][] = [
  ['Left thumb', 'Steer: drag to pitch and turn'],
  ['Right thumb', 'Drag up or down to set the throttle (it stays set); left or right to roll'],
  ['Level', 'Roll back level'],
  ['FA', 'Flight assist on or off'],
  ['Tap a planet', 'Lock a target'],
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
  const titleId = useId()
  const touch = prefersTouch()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      // The mouse's turn demand holds until the pointer next moves, and the
      // dialog stops it moving over the view: don't spin behind the dialog.
      shipInput.pitch = 0
      shipInput.yaw = 0
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Escape closes the dialog only. The capture phase runs before ShipView's
  // window listener, which skips a defaultPrevented Escape instead of exiting.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [open, onClose])

  const isBackdrop = (e: React.MouseEvent) => e.target === e.currentTarget

  return (
    <Dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onMouseDown={(e) => {
        pressedBackdrop.current = isBackdrop(e)
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && isBackdrop(e)) onClose()
      }}
    >
      <Body>
        <Header>
          <Title id={titleId}>How to fly</Title>
          <CloseButton
            type="button"
            onClick={onClose}
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
          faster you go. Lock a target and you slow down as you arrive.
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
          type="button"
          onClick={onClose}
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
  max-height: calc(100dvh - 32px);
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
    white-space: nowrap;
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
