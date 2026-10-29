import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DemoBarView, type DemoBarViewProps } from './DemoBar'
import { DemoMenu } from './DemoMenu'
import { DEMOS } from './demos'

describe('DemoMenu', () => {
  it('is a named button that opens the list', () => {
    const html = renderToStaticMarkup(<DemoMenu />)
    expect(html).toContain('aria-label="Demos"')
    expect(html).not.toContain('aria-haspopup')
    expect(html).toContain('aria-expanded="false"')
    // Only while open: it would name a list that isn't there.
    expect(html).not.toContain('aria-controls')
    expect(html).toContain('data-demo-button')
  })
})

describe('DemoBarView', () => {
  const demo = DEMOS[0]
  const props = (overrides: Partial<DemoBarViewProps> = {}): DemoBarViewProps => ({
    demo,
    step: 0,
    playing: false,
    onStep: () => {},
    onTogglePlaying: () => {},
    onExit: () => {},
    ...overrides,
  })

  it('shows the step caption, its place and named controls', () => {
    const html = renderToStaticMarkup(<DemoBarView {...props()} />)
    expect(html).toContain(`aria-label="Demo: ${demo.title}"`)
    expect(html).toContain(demo.steps[0].caption.title)
    expect(html).toContain(`1 / ${demo.steps.length}`)
    expect(html).toContain('aria-live="polite"')
    // aria-disabled, so focus isn't dropped on the first step.
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*aria-label="Previous step"/)
    expect(html).not.toMatch(/ disabled=""/)
    // The count is shown, and spoken as words.
    expect(html).toContain('Step 1 of ')
    expect(html).toMatch(/<button[^>]*aria-describedby="[^"]+"[^>]*>Next/)
    expect(html).toContain('aria-label="Exit demo"')
    expect(html).toContain('aria-label="Play time"')
    expect(html).toContain('Next')
  })

  it('offers Pause while the clock runs, and Done on the last step', () => {
    const step = demo.steps.length - 1
    const html = renderToStaticMarkup(<DemoBarView {...props({ step, playing: true })} />)
    expect(html).toContain('aria-label="Pause time"')
    expect(html).toContain('Done')
    expect(html).toContain(`${demo.steps.length} / ${demo.steps.length}`)
  })
})
