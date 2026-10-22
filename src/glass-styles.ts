// The dock's glass styles, shared by the dock (controls.tsx), its toggle and
// the date picker.

/** The phone breakpoint, as in index.css. */
export const PHONE = '@media (max-width: 600px)'

export const glassButton = `
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: var(--dock-button-size, 40px);
  height: var(--dock-button-size, 40px);
  padding: 0;
  margin: 0;
  background: transparent;
  color: rgba(255, 255, 255, 0.78);
  border: none;
  border-radius: 999px;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;

  &:hover {
    background-color: rgba(255, 255, 255, 0.14);
    color: #fff;
  }

  &:focus-visible {
    outline: 2px solid #4c9ffe;
    outline-offset: 1px;
  }
`

export const glassPanel = `
  background-color: rgba(30, 30, 34, 0.55);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  backdrop-filter: blur(24px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    0 10px 30px rgba(0, 0, 0, 0.4);
`

/** A quiet round glass button floating over a view, like the compass. */
export const glassFloatingButton = `
  ${glassButton}
  ${glassPanel}
  position: relative;
  color: rgba(255, 255, 255, 0.6);
  transition:
    background-color 120ms ease,
    color 120ms ease,
    border-color 200ms ease,
    box-shadow 200ms ease;

  /* A 48px tap target around the 40px disc. */
  &::before {
    content: '';
    position: absolute;
    inset: -4px;
  }

  /* Touch keeps :hover after a tap. */
  @media (hover: none) {
    &:hover {
      background-color: rgba(30, 30, 34, 0.55);
      color: rgba(255, 255, 255, 0.6);
    }
  }

  &:focus-visible {
    outline-color: #fff;
    outline-offset: 3px;
  }
`
