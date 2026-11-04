import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SeaIceNoteLine } from './SeaIceNote'

describe('SeaIceNoteLine', () => {
  it('names the year the ice is from', () => {
    const html = renderToStaticMarkup(<SeaIceNoteLine year={2025} />)
    const visible = html.replace(/<span class="visually-hidden">.*?<\/span>/, '').replace(/<[^>]+>/g, '').replace(/<!-- -->/g, '')
    expect(visible).toBe('Sea ice: 2025 data')
    expect(html).toContain('class="sea-ice-note"')
    // Read out in full: what the year means for the date shown.
    expect(html.replace(/<[^>]+>/g, '').replace(/<!-- -->/g, '')).toContain('2025’s sea ice for this day of the year')
  })

  it('takes ship mode\'s corner style there (tides-6ru.2)', () => {
    expect(renderToStaticMarkup(<SeaIceNoteLine year={2025} ship />)).toContain('class="sea-ice-note sea-ice-note--ship"')
  })
})
