import styled from 'styled-components'
import { IconAdjustmentsHorizontal, IconX } from '@tabler/icons-react'
import { glassButton, PHONE } from './glass-styles'

/** Folds and unfolds the phone dock (see dock-disclosure.ts); hidden above phone width. */
export default function DockToggle({
  ref,
  expanded,
  onToggle,
}: {
  ref: React.Ref<HTMLButtonElement>
  expanded: boolean
  onToggle: () => void
}) {
  const Icon = expanded ? IconX : IconAdjustmentsHorizontal
  return (
    <ToggleButton
      ref={ref}
      type="button"
      data-dock-toggle
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label="Controls"
      title={expanded ? 'Hide controls' : 'Show controls'}
    >
      <Icon
        size={20}
        stroke={2}
      />
    </ToggleButton>
  )
}

const ToggleButton = styled.button`
  ${glassButton}
  display: none;

  ${PHONE} {
    display: flex;
  }
`
