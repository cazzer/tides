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
  it('shows the name over its two stats', () => {
    const html = renderToStaticMarkup(
      <FocusTitleView title={{ name: 'Mars', size: '6,780 km wide', comparison: 'about half Earth’s width' }} />
    )
    expect(html).toContain('class="focus-title"')
    expect(html).toContain('<p class="focus-title__name">Mars</p>')
    expect(html).toContain('class="focus-title__stats"')
    expect(html).toContain('<span class="focus-title__stat">6,780 km wide</span>')
    expect(html).toContain('<span class="focus-title__stat">about half Earth’s width</span>')
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
    expect(html).toContain(`${(116_000).toLocaleString()} km wide`)
  })
})
