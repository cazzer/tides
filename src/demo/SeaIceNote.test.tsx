import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SeaIceNoteLine } from './SeaIceNote'

describe('SeaIceNoteLine', () => {
  it('names the year the ice is from', () => {
    const html = renderToStaticMarkup(<SeaIceNoteLine year={2025} />)
    expect(html.replace(/<[^>]+>/g, '').replace(/<!-- -->/g, '')).toBe('Sea ice: 2025 data')
    expect(html).toContain('class="sea-ice-note"')
  })
})
