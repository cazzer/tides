import { useSyncExternalStore } from 'react'
import styled from 'styled-components'
import { IconVolume, IconVolumeOff } from '@tabler/icons-react'
import { glassButton } from '../../glass-styles'
import { shipAudio } from './ship-audio'

/** The HUD's mute toggle (tides-a4j.1); pressed is muted. */
export function ShipSoundButton() {
  const muted = useSyncExternalStore(shipAudio.subscribe, shipAudio.isMuted, shipAudio.isMuted)
  const Icon = muted ? IconVolumeOff : IconVolume
  return (
    <SoundButton
      type="button"
      onClick={() => shipAudio.setMuted(!muted)}
      aria-pressed={muted}
      aria-label="Mute ship sound"
      title="Sound"
    >
      <Icon
        size={16}
        stroke={1.75}
        aria-hidden
      />
    </SoundButton>
  )
}

// As the HUD's clear-target button: a small glyph in the strip's row.
const SoundButton = styled.button`
  ${glassButton}
  flex: none;
  width: 24px;
  height: 24px;
  margin: -4px 0;
  position: relative;

  /* A 40px tap target around the small glyph. */
  &::before {
    content: '';
    position: absolute;
    inset: -8px;
  }
`
