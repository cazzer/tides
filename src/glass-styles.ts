// Copies of the dock's glass styles in controls.tsx, which can't be imported
// from there without a circular import (tides follow-up: dedupe).

export const glassButton = `
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
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
