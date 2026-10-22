import { describe, expect, it } from 'vitest'
import { resolveQualityTier } from './quality'

const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36'

describe('resolveQualityTier', () => {
  it('is high on desktop and low on phones', () => {
    expect(resolveQualityTier('', DESKTOP)).toBe('high')
    expect(resolveQualityTier('', IPHONE)).toBe('low')
    expect(resolveQualityTier('', ANDROID)).toBe('low')
  })

  it('takes ?quality over the user agent', () => {
    expect(resolveQualityTier('?quality=low', DESKTOP)).toBe('low')
    expect(resolveQualityTier('?ship=1&quality=high', IPHONE)).toBe('high')
  })

  it('ignores an unknown ?quality', () => {
    expect(resolveQualityTier('?quality=ultra', DESKTOP)).toBe('high')
    expect(resolveQualityTier('?quality=', IPHONE)).toBe('low')
  })
})
