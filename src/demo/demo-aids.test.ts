import { describe, expect, it } from 'vitest'
import type { Demo } from './demo-script'
import { demoAidAt, demoAidOn } from './demo-aids'
import { exitDemoPatch, type DemoSessionState } from './demo-session'
import { findDemo } from './demos'

const step = (aids?: Demo['steps'][number]['aids']) => ({
  date: '2024-04-08T18:00:00Z',
  aids,
  caption: { title: 't', body: 'b' },
})

describe('demoAidAt', () => {
  const demo: Demo = {
    id: 'aids',
    title: 'Aids',
    blurb: 'b',
    steps: [step({ solarEclipseSky: true, hideMoon: true }), step(), step({ moonNodes: true, solarEclipseSky: false })],
  }

  it('carries each aid over until a step turns it off', () => {
    expect([0, 1, 2].map((i) => demoAidAt(demo, i, 'solarEclipseSky'))).toEqual([true, true, false])
    expect([0, 1, 2].map((i) => demoAidAt(demo, i, 'moonNodes'))).toEqual([false, false, true])
    expect([0, 1, 2].map((i) => demoAidAt(demo, i, 'hideMoon'))).toEqual([true, true, true])
  })
})

describe('demoAidOn', () => {
  it('is off outside a demo and for a demo that isn’t there', () => {
    expect(demoAidOn({ demo: null }, 'solarEclipseSky')).toBe(false)
    expect(demoAidOn({ demo: { id: 'no-such-demo', step: 0 } }, 'solarEclipseSky')).toBe(false)
  })

  it('follows the solar eclipse’s steps', () => {
    const demo = findDemo('solar-eclipse')!
    // The Torreón sky only for the steps that look at it, so the enlarged
    // Moon never stays on to be seen through the ground.
    const on = (key: 'solarEclipseSky' | 'moonNodes' | 'moonShadow') =>
      demo.steps.map((_, i) => demoAidOn({ demo: { id: demo.id, step: i } }, key))
    expect(on('solarEclipseSky')).toEqual([false, true, true, false, false])
    expect(on('moonNodes')).toEqual([false, false, false, false, true])
    expect(on('moonShadow')).toEqual([true, true, true, true, false])
  })

  it('is off once the demo is left', () => {
    const s = {
      demo: { id: 'solar-eclipse', step: 4 },
      demoSaved: { enteredAt: 0, timeScale: 1, timestamp: null },
    } as unknown as DemoSessionState
    const left = { ...s, ...exitDemoPatch(s) }
    expect(demoAidOn(left, 'solarEclipseSky')).toBe(false)
    expect(demoAidOn(left, 'moonNodes')).toBe(false)
    expect(demoAidOn(left, 'moonShadow')).toBe(false)
  })
})
