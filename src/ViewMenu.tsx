import { useEffect, useId, useRef, useState } from 'react'
import { IconChevronUp } from '@tabler/icons-react'
import type { PanelKey } from './store'

/** The single-layout panel chip: a menu button that picks which View fills the panel. */
export default function ViewMenu({
  value,
  options,
  onChange,
}: {
  value: PanelKey
  options: { value: PanelKey; label: string }[]
  onChange: (value: PanelKey) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const menuId = useId()
  const currentIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  )

  useEffect(() => {
    if (!open) return
    itemRefs.current[currentIndex]?.focus()
    const onOutside = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open, currentIndex])

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
    }
  }

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    const focused = itemRefs.current.indexOf(
      document.activeElement as HTMLButtonElement
    )
    const focusItem = (i: number) =>
      itemRefs.current[(i + options.length) % options.length]?.focus()
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusItem(focused + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        focusItem(focused - 1)
        break
      case 'Home':
        e.preventDefault()
        focusItem(0)
        break
      case 'End':
        e.preventDefault()
        focusItem(options.length - 1)
        break
      case 'Escape':
        e.preventDefault()
        close()
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  return (
    <div
      ref={wrapRef}
      className="view-menu"
    >
      <button
        ref={triggerRef}
        className="panel-label"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleTriggerKeyDown}
      >
        {options[currentIndex].label}
        <IconChevronUp
          size={12}
          stroke={2}
          aria-hidden
        />
      </button>
      {open && (
        <div
          id={menuId}
          className="view-menu__list"
          role="menu"
          aria-label="Choose view"
          onKeyDown={handleMenuKeyDown}
        >
          {options.map((option, i) => (
            <button
              key={option.value}
              ref={(el) => {
                itemRefs.current[i] = el
              }}
              className="view-menu__item"
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              tabIndex={-1}
              onClick={() => {
                onChange(option.value)
                close()
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
