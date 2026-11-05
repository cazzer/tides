import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('useGlowOn', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('../../quality')
    vi.resetModules()
  })

  it('is false outside a GlowView and on inside one, with glow on for the page', async () => {
    vi.resetModules()
    vi.doMock('../../quality', () => ({ qualityTier: () => 'high' }))
    vi.stubGlobal('window', { location: { search: '' } })
    const { GlowView, glowOn, useGlowOn } = await import('./glowSources')
    expect(glowOn()).toBe(true)
    const seen: boolean[] = []
    const Probe = () => {
      seen.push(useGlowOn())
      return null
    }
    renderToString(createElement(Probe))
    renderToString(createElement(GlowView, null, createElement(Probe)))
    expect(seen).toEqual([false, true])
  })
})
