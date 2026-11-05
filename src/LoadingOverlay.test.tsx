import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'

vi.mock('@react-three/drei', () => ({
  useProgress: () => ({
    active: true,
    progress: 40,
    item: 'https://example.com/textures/earth_daymap_8k.jpg',
    loaded: 2,
    total: 5,
  }),
}))

const { default: LoadingOverlay } = await import('./LoadingOverlay')

// The loading screen (tides-6m0.4): the mark, not the assets' file names.
describe('LoadingOverlay', () => {
  const html = renderToStaticMarkup(<LoadingOverlay sceneReady={false} />)

  test('shows the mark and the name, not the file loading', () => {
    expect(html).toContain('icon.svg')
    expect(html).toContain('Tides')
    expect(html).not.toContain('earth_daymap')
    expect(html).not.toMatch(/\d+\/\d+/)
  })

  test('has a named progress bar and says it is loading', () => {
    expect(html).toMatch(/role="progressbar"[^>]*aria-label="Loading"/)
    expect(html).toMatch(/aria-valuenow="36"/)
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('Loading Tides')
  })
})
