import { useEffect, useRef, useState } from 'react'
import { PHONE } from './glass-styles'

/**
 * On a phone the dock folds into one button in the top-left corner; this is
 * that button's disclosure state. Tapping outside the dock or pressing Escape
 * inside it folds it again. Above the phone breakpoint the button is hidden
 * and the state has no effect.
 */
export function useDockDisclosure() {
  const [expanded, setExpanded] = useState(false)
  const dockRef = useRef<HTMLElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!expanded) return
    // Capture: the canvas's orbit controls take the pointer for drags.
    const onOutside = (e: PointerEvent) => {
      if (!dockRef.current?.contains(e.target as Node)) setExpanded(false)
    }
    document.addEventListener('pointerdown', onOutside, true)
    return () => document.removeEventListener('pointerdown', onOutside, true)
  }, [expanded])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || !expanded || e.defaultPrevented) return
    // The settings dialog closes itself on Escape and keeps the dock open.
    if ((e.target as Element).closest('dialog')) return
    setExpanded(false)
    toggleRef.current?.focus()
  }

  return {
    dockRef,
    dockProps: { 'data-expanded': expanded, onKeyDown },
    toggleProps: {
      ref: toggleRef,
      expanded,
      onToggle: () => setExpanded((x) => !x),
    },
  }
}

/**
 * The dock's phone layout: a glass circle at the top-left that widens
 * across the top when expanded. Everything but the toggle hides while folded;
 * visibility (not display) keeps the controls' layout, so they fade in place.
 */
export const phoneDock = `
  ${PHONE} {
    top: var(--dock-top);
    bottom: auto;
    left: var(--dock-inset-left);
    right: auto;
    margin: 0;
    width: var(--dock-height);
    max-width: none;
    justify-content: space-between;
    transition: width 240ms cubic-bezier(0.2, 0.8, 0.2, 1);

    &[data-expanded='true'] {
      width: calc(100% - var(--dock-inset-left) - var(--dock-inset-right));
      /* What doesn't fit wraps to a second row, once the dock has widened:
       * wrapping while it widens would stack the controls in a column. */
      flex-wrap: wrap;
      height: auto;
      min-height: var(--dock-height);
      padding-block: calc((var(--dock-height) - var(--dock-button-size, 40px)) / 2);
      border-radius: calc(var(--dock-height) / 2);
      transition:
        width 240ms cubic-bezier(0.2, 0.8, 0.2, 1),
        flex-wrap 0s linear 240ms;
      transition-behavior: allow-discrete;
    }

    & > :not([data-dock-toggle]) {
      transition:
        opacity 200ms ease 80ms,
        visibility 0s;
    }

    &[data-expanded='false'] > :not([data-dock-toggle]) {
      visibility: hidden;
      opacity: 0;
      transition:
        opacity 120ms ease,
        visibility 0s linear 120ms;
    }

    @media (prefers-reduced-motion: reduce) {
      &,
      & > :not([data-dock-toggle]) {
        transition: none !important;
      }
    }
  }

  /* With the toggle, the controls fit a 320px phone only this tightly. */
  @media (max-width: 360px) {
    gap: 3px;
  }
`

/** Popovers that open upward from the bottom dock open downward on a phone. */
export const opensDownOnPhone = `
  ${PHONE} {
    top: 100%;
    bottom: auto;
    margin-top: 14px;
    margin-bottom: 0;
    max-height: calc(100dvh - var(--dock-top) - var(--dock-height) - 26px);
  }
`
