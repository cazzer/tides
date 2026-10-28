import styled from 'styled-components'
import { useEffect, useId, useRef, useState } from 'react'
import { IconPresentation } from '@tabler/icons-react'
import { useStore } from '../store'
import { glassButton, glassPanel, PHONE } from '../glass-styles'
import { opensDownOnPhone } from '../dock-disclosure'
import { DEMOS } from './demos'

/**
 * The dock's list of guided demos (tides-zec.5). Picking one starts it; a
 * demo never starts on its own.
 */
export function DemoMenu() {
  const startDemo = useStore((s) => s.startDemo)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    // Capture: the canvas's orbit controls take the pointer for drags.
    const onOutside = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onOutside, true)
    return () => document.removeEventListener('pointerdown', onOutside, true)
  }, [open])

  return (
    <Wrap
      ref={ref}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return
        // Kept from the dock, which would fold on the same Escape.
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }}
    >
      <Trigger
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Demos"
        title="Demos"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-demo-button
      >
        <IconPresentation size={20} stroke={2} />
      </Trigger>
      {open && (
        <Menu id={menuId} aria-label="Demos">
          {DEMOS.map((demo) => (
            <li key={demo.id}>
              <Option
                type="button"
                onClick={() => {
                  setOpen(false)
                  startDemo(demo.id)
                }}
              >
                <OptionTitle>{demo.title}</OptionTitle>
                <OptionBlurb>{demo.blurb}</OptionBlurb>
              </Option>
            </li>
          ))}
        </Menu>
      )}
    </Wrap>
  )
}

const Wrap = styled.div`
  position: relative;

  /* On a phone the button may wrap to the dock's second row, so the menu
   * hangs from the dock itself, not from the button. */
  ${PHONE} {
    position: static;
  }
`

const Trigger = styled.button`
  ${glassButton}
`

// Opens upward from the bottom dock, right-aligned so it stays on screen.
const Menu = styled.ul`
  position: absolute;
  bottom: 100%;
  right: 0;
  margin: 0 0 14px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: min(280px, calc(100vw - 24px));
  padding: 6px;
  max-height: calc(100dvh - 72px);
  overflow-y: auto;
  border-radius: 18px;
  z-index: 100;
  ${glassPanel}
  ${opensDownOnPhone}

  ${PHONE} {
    left: 0;
    right: auto;
  }
`

const Option = styled.button`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 8px 10px;
  margin: 0;
  text-align: left;
  font: inherit;
  background: transparent;
  color: rgba(255, 255, 255, 0.78);
  border: none;
  border-radius: 12px;
  cursor: pointer;

  &:hover {
    background-color: rgba(255, 255, 255, 0.14);
    color: #fff;
  }

  &:focus-visible {
    outline: 2px solid #4c9ffe;
    outline-offset: -2px;
  }
`

const OptionTitle = styled.span`
  font-size: 14px;
  font-weight: 600;
  color: #fff;
`

const OptionBlurb = styled.span`
  font-size: 12px;
  line-height: 1.4;
`
