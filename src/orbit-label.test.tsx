import { renderToStaticMarkup } from 'react-dom/server'
import type * as THREE from 'three'
import { describe, expect, test, vi } from 'vitest'

const { state, texts } = vi.hoisted(() => ({
  state: { showPlanets: false, demo: null as { id: string; step: number } | null },
  texts: [] as Record<string, unknown>[],
}))
vi.mock('@react-three/fiber', () => ({ useFrame: () => {} }))
vi.mock('@react-three/drei', () => ({
  Text: (props: Record<string, unknown>) => {
    texts.push(props)
    return null
  },
}))
vi.mock('./camera', () => ({ useCamera: () => ({ handleFocus: () => {} }) }))
vi.mock('./store', () => {
  const store = Object.assign(
    (select: (s: object) => unknown) =>
      select({ showPlanets: state.showPlanets, demo: state.demo, setPlanet: () => {} }),
    { getState: () => ({ timestamp: Date.parse('2026-10-27T12:00:00Z') }) }
  )
  return { useStore: store }
})

const { OrbitLabel } = await import('./orbit-label')

function clockText(showPlanets: boolean) {
  state.showPlanets = showPlanets
  texts.length = 0
  renderToStaticMarkup(<OrbitLabel radius={100} />)
  return texts.find((t) => t['userData-focus'] === 'clock')!
}

describe('OrbitLabel clock', () => {
  // The planets' globes write depth (their shells and rings do not), so a
  // depth-tested clock is hidden by a planet in front of it, as by Earth.
  test.each([false, true])('is depth-tested with planets shown: %s', (showPlanets) => {
    const clock = clockText(showPlanets)
    const material = clock.material as THREE.Material
    expect(material.depthTest).toBe(true)
    expect(material.depthWrite).toBe(false)
    expect(clock.renderOrder ?? 0).toBe(0)
  })
})

describe('OrbitLabel in a demo', () => {
  // The caption's clock is the only one (tides-zec.15).
  test.each([
    [null, true],
    [{ id: 'seasons', step: 0 }, false],
  ])('demo %o shows the clock and months: %s', (demo, shown) => {
    state.demo = demo
    texts.length = 0
    renderToStaticMarkup(<OrbitLabel radius={100} />)
    state.demo = null
    expect(texts).toHaveLength(13)
    for (const text of texts) expect(text.visible).toBe(shown)
    const clock = texts.find((t) => t['userData-focus'] === 'clock')!
    expect(clock.onClick === undefined).toBe(!shown)
  })
})
