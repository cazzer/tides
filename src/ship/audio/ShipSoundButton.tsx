import { useSyncExternalStore } from 'react'
import styled from 'styled-components'
import { IconVolume, IconVolumeOff } from '@tabler/icons-react'
import { hudGlyphButton, PHONE } from '../../glass-styles'
import { shipAudio } from './ship-audio'

const LABEL = 'Mute ship sound (M)'

/** The HUD's mute toggle (tides-a4j.1); pressed is muted. */
export function ShipSoundButton() {
  const muted = useSyncExternalStore(shipAudio.subscribe, shipAudio.isMuted, shipAudio.isMuted)
  const Icon = muted ? IconVolumeOff : IconVolume
  return (
    <SoundButton
      type="button"
      onClick={() => shipAudio.setMuted(!muted)}
      aria-pressed={muted}
      aria-label={LABEL}
      title={LABEL}
    >
      <Icon
        size={16}
        stroke={1.75}
        aria-hidden
      />
    </SoundButton>
  )
}

const SoundButton = styled.button`
  ${hudGlyphButton}

  /* The phone's narrower row gap would let its tap target meet the
     clear-target button's. */
  ${PHONE} {
    margin-left: 4px;
  }
`
