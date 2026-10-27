import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveFlightTextureCap, resolveQualityTier, savedQualityChoice, saveQualityChoice } from './quality'

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

  it('takes the URL over the saved choice, and the saved choice over the device', () => {
    expect(resolveQualityTier('', IPHONE, 'high')).toBe('high')
    expect(resolveQualityTier('', DESKTOP, 'low')).toBe('low')
    expect(resolveQualityTier('?quality=low', DESKTOP, 'high')).toBe('low')
    expect(resolveQualityTier('?quality=high', IPHONE, 'low')).toBe('high')
    expect(resolveQualityTier('', IPHONE, 'auto')).toBe('low')
    expect(resolveQualityTier('', DESKTOP, 'junk')).toBe('high')
  })
})

describe('the saved quality choice', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function memoryStorage(): Storage {
    const items = new Map<string, string>()
    return {
      get length() {
        return items.size
      },
      clear: () => items.clear(),
      getItem: (key) => items.get(key) ?? null,
      key: (i) => [...items.keys()][i] ?? null,
      removeItem: (key) => void items.delete(key),
      setItem: (key, value) => void items.set(key, value),
    }
  }

  it('round-trips, and auto clears it', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    expect(savedQualityChoice()).toBe('auto')
    expect(saveQualityChoice('low')).toBe(true)
    expect(savedQualityChoice()).toBe('low')
    expect(saveQualityChoice('auto')).toBe(true)
    expect(savedQualityChoice()).toBe('auto')
  })

  it('falls back to auto when storage throws', () => {
    const throwing = memoryStorage()
    throwing.getItem = () => {
      throw new Error('SecurityError')
    }
    throwing.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    vi.stubGlobal('localStorage', throwing)
    expect(saveQualityChoice('high')).toBe(false)
    expect(savedQualityChoice()).toBe('auto')
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

  it('takes the saved choice over the device, and ?quality over both', () => {
    expect(resolveFlightTextureCap('', DESKTOP, 0, 16384, 'low')).toBe(4096)
    expect(resolveFlightTextureCap('', IPHONE, 5, 16384, 'high')).toBe(8192)
    expect(resolveFlightTextureCap('?quality=high', DESKTOP, 0, 16384, 'low')).toBe(8192)
  })

  it('never exceeds the GPU, and is off below 4k', () => {
    expect(resolveFlightTextureCap('', DESKTOP, 0, 4096)).toBe(4096)
    expect(resolveFlightTextureCap('', DESKTOP, 0, 2048)).toBeNull()
  })
})
