import { describe, expect, it } from 'vitest'
import { resolveFlightTextureCap, resolveQualityTier } from './quality'

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

describe('resolveFlightTextureCap', () => {
  const IPAD = DESKTOP.replace('Chrome/141.0 Safari/537.36', 'Version/18.0 Safari/605.1.15')

  it('is 8k on desktops and 4k on phones and iPads', () => {
    expect(resolveFlightTextureCap('', DESKTOP, 0, 16384)).toBe(8192)
    expect(resolveFlightTextureCap('', IPHONE, 5, 16384)).toBe(4096)
    expect(resolveFlightTextureCap('', ANDROID, 5, 16384)).toBe(4096)
    // iPadOS's UA is a Mac's; only its touch points differ.
    expect(resolveFlightTextureCap('', IPAD, 5, 16384)).toBe(4096)
    expect(resolveFlightTextureCap('', IPAD, 0, 16384)).toBe(8192)
  })

  it('takes ?quality over the device', () => {
    expect(resolveFlightTextureCap('?quality=low', DESKTOP, 0, 16384)).toBe(4096)
    expect(resolveFlightTextureCap('?quality=high', IPAD, 5, 16384)).toBe(8192)
  })

  it('never exceeds the GPU, and is off below 4k', () => {
    expect(resolveFlightTextureCap('', DESKTOP, 0, 4096)).toBe(4096)
    expect(resolveFlightTextureCap('', DESKTOP, 0, 2048)).toBeNull()
  })
})
