import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { DepthInfo, DepthInfoPanel } from './DepthInfo'
import type { DepthReport } from './depth-precision'

const report: DepthReport = {
  precision: { kind: 'float', bits: 32, maxPassK: 63, ms: 9.2 },
  targets: [
    { name: 'D16', kind: 'unorm', bits: 16, maxPassK: 16, ms: 1 },
    { name: 'D32FS8x4', error: 'Error: no' },
  ],
  reversed: true,
  clipControl: true,
  depthBits: 24,
  stencilBits: 8,
  componentType: 'UNSIGNED_NORMALIZED',
  antialias: true,
  stencil: true,
  renderer: 'Apple GPU',
  drawingBuffer: '780x1688',
  pixelRatio: 2,
  userAgent: 'iPhone',
}

describe('DepthInfoPanel', () => {
  test('says it is probing until the report lands', () => {
    expect(renderToStaticMarkup(<DepthInfoPanel report={null} />)).toContain('data-depth-info="pending"')
  })

  test('shows the verdict as text and data attributes', () => {
    const html = renderToStaticMarkup(<DepthInfoPanel report={report} />)
    expect(html).toContain('Depth: reversed, float (k&gt;=63)')
    expect(html).toContain('data-kind="float"')
    expect(html).toContain('data-reversed-float="true"')
    expect(html).toContain('data-targets="D16 unorm 16 (k=16); D32FS8x4 error"')
    expect(html).toContain('yes (reversed + float)')
  })

  test('calls the floor off on standard depth', () => {
    const html = renderToStaticMarkup(<DepthInfoPanel report={{ ...report, reversed: false }} />)
    expect(html).toContain('data-reversed-float="false"')
    expect(html).toContain('Depth: standard, float')
  })
})

describe('DepthInfo', () => {
  test('is off without ?depth=info', () => {
    expect(renderToStaticMarkup(<DepthInfo />)).toBe('')
  })
})
