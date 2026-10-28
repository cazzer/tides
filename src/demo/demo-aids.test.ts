import { describe, expect, it } from 'vitest'
import type { Demo } from './demo-script'
import { demoAidOn, demoAidsAt } from './demo-aids'
import { exitDemoPatch, type DemoSessionState } from './demo-session'
import { findDemo } from './demos'

const step = (aids?: Demo['steps'][number]['aids']) => ({
  date: '2024-04-08T18:00:00Z',
  aids,
  caption: { title: 't', body: 'b' },
})

describe('demoAidsAt', () => {
  const demo: Demo = {
    id: 'aids',
    title: 'Aids',
    blurb: 'b',
    steps: [step({ solarEclipseSky: true }), step(), step({ moonNodes: true, solarEclipseSky: false })],
  }

  it('carries each aid over until a step turns it off', () => {
    expect(demoAidsAt(demo, 0)).toEqual({ solarEclipseSky: true })
    expect(demoAidsAt(demo, 1)).toEqual({ solarEclipseSky: true })
    expect(demoAidsAt(demo, 2)).toEqual({ solarEclipseSky: false, moonNodes: true })
  })
})

describe('demoAidOn', () => {
  it('is off outside a demo and for a demo that isn’t there', () => {
    expect(demoAidOn({ demo: null }, 'solarEclipseSky')).toBe(false)
    expect(demoAidOn({ demo: { id: 'no-such-demo', step: 0 } }, 'solarEclipseSky')).toBe(false)
  })

  it('follows the solar eclipse’s steps', () => {
    const demo = findDemo('solar-eclipse')!
    demo.steps.forEach((_, i) => {
      const s = { demo: { id: demo.id, step: i } }
      expect(demoAidOn(s, 'solarEclipseSky')).toBe(true)
      expect(demoAidOn(s, 'moonNodes')).toBe(i === demo.steps.length - 1)
    })
  })

  it('is off once the demo is left', () => {
    const s = {
      demo: { id: 'solar-eclipse', step: 4 },
      demoSaved: { enteredAt: 0, timeScale: 1, timestamp: null },
    } as unknown as DemoSessionState
    const left = { ...s, ...exitDemoPatch(s) }
    expect(demoAidOn(left, 'solarEclipseSky')).toBe(false)
    expect(demoAidOn(left, 'moonNodes')).toBe(false)
  })
})
