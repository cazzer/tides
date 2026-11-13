import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CameraFocus } from './store'
import { FocusTitle, FocusTitleView } from './FocusTitle'

// A server render reads zustand's initial state, not setState's, so the
// focus comes from here (as CloudsShown.test.tsx does).
const { state } = vi.hoisted(() => ({ state: { cameraFocus: 'earth' as CameraFocus } }))
vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  useStore: (select: (s: { cameraFocus: CameraFocus }) => unknown) => select(state),
}))

describe('FocusTitleView', () => {
  it('shows the name over one line of stats', () => {
    const html = renderToStaticMarkup(
      <FocusTitleView title={{ name: 'Mars', size: '6,780 km', comparison: '0.53× Earth' }} />
    )
    expect(html).toContain('class="focus-title"')
    expect(html).toContain('<h2 class="focus-title__name">Mars</h2>')
    expect(html).not.toContain('aria-live')
    // The dot is drawn, not read; the spaces round it are read.
    expect(html).toContain('<p class="focus-title__stats">6,780 km <span aria-hidden="true">·</span> 0.53× Earth</p>')
    expect(html).not.toContain('visually-hidden')
    expect(html.replace(/<span[^>]*aria-hidden="true"[^>]*>.*?<\/span>/g, '').replace(/<[^>]+>/g, '')).toBe(
      'Mars6,780 km  0.53× Earth'
    )
  })

  it('shows a tiny moon’s size alone', () => {
    const html = renderToStaticMarkup(<FocusTitleView title={{ name: 'Phobos', size: '22 km', comparison: null }} />)
    expect(html).toContain('<p class="focus-title__stats">22 km</p>')
  })
})

describe('FocusTitle', () => {
  afterEach(() => {
    state.cameraFocus = 'earth'
  })

  it('is empty off the planets and moons', () => {
    state.cameraFocus = 'clock'
    expect(renderToStaticMarkup(<FocusTitle />)).toBe('')
  })

  it('names the focused planet', () => {
    state.cameraFocus = 'saturn'
    const html = renderToStaticMarkup(<FocusTitle />)
    expect(html).toContain('Saturn')
    expect(html).toContain('116,000 km <span aria-hidden="true">·</span> 9.1× Earth')
  })
})
