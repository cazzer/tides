import { describe, expect, it } from 'vitest'
import { canFlipBitmaps } from './planetTextures'

describe('canFlipBitmaps', () => {
  it('trusts Chrome, Safari 17+ and Firefox 98+', () => {
    expect(canFlipBitmaps('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36')).toBe(true)
    expect(canFlipBitmaps('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe(true)
    expect(canFlipBitmaps('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:98.0) Gecko/20100101 Firefox/98.0')).toBe(true)
  })

  it('keeps the image path on Safari 16, Firefox 97 and iOS Chrome', () => {
    expect(canFlipBitmaps('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15')).toBe(false)
    expect(canFlipBitmaps('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:97.0) Gecko/20100101 Firefox/97.0')).toBe(false)
    expect(canFlipBitmaps('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1')).toBe(false)
  })
})
