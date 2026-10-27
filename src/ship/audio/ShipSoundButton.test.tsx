import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test } from 'vitest'
import { shipAudio } from './ship-audio'
import { ShipSoundButton } from './ShipSoundButton'

describe('ShipSoundButton (tides-a4j.1)', () => {
  afterEach(() => shipAudio.setMuted(false))

  test('is a toggle, pressed while muted, with the matching glyph', () => {
    const unmuted = renderToStaticMarkup(<ShipSoundButton />)
    expect(unmuted).toContain('aria-label="Mute ship sound"')
    expect(unmuted).toContain('aria-pressed="false"')
    expect(unmuted).toContain('tabler-icon-volume ')

    shipAudio.setMuted(true)
    const muted = renderToStaticMarkup(<ShipSoundButton />)
    expect(muted).toContain('aria-pressed="true"')
    expect(muted).toContain('tabler-icon-volume-off ')
  })
})
