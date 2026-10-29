import { renderToStaticMarkup } from 'react-dom/server'
import type * as THREE from 'three'
import { describe, expect, test, vi } from 'vitest'

const { state, texts } = vi.hoisted(() => ({
  state: { showPlanets: false, demo: null as { id: string; step: number } | null, months: false },
  texts: [] as Record<string, unknown>[],
}))
vi.mock('@react-three/fiber', () => ({ useFrame: () => {} }))
vi.mock('@react-three/drei', () => ({
  Text: (props: Record<string, unknown>) => {
    texts.push(props)
    return null
  },
}))
vi.mock('./demo/demo-aids', () => ({ useDemoAid: () => state.months }))
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
  function shown(demo: typeof state.demo, months = false) {
    state.demo = demo
    state.months = months
    texts.length = 0
    renderToStaticMarkup(<OrbitLabel radius={100} />)
    state.demo = null
    state.months = false
    const clock = texts.find((t) => t['userData-focus'] === 'clock')!
    const monthTexts = texts.filter((t) => t !== clock)
    expect(monthTexts).toHaveLength(12)
    expect(new Set(monthTexts.map((t) => t.visible)).size).toBe(1)
    return { clock: clock.visible, clickable: clock.onClick !== undefined, months: monthTexts[0].visible }
  }

  // The caption's clock is the only one (tides-zec.15).
  test('outside a demo shows the clock and months', () => {
    expect(shown(null)).toEqual({ clock: true, clickable: true, months: true })
  })

  test('in a demo hides the clock and months', () => {
    expect(shown({ id: 'seasons', step: 0 })).toEqual({ clock: false, clickable: false, months: false })
  })

  test('a step with monthLabels shows the months, not the clock', () => {
    expect(shown({ id: 'seasons', step: 0 }, true)).toEqual({ clock: false, clickable: false, months: true })
  })
})
