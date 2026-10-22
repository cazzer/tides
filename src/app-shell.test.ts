import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

// The page shell that makes the app full-bleed and installable on a phone
// (tides-2hv.2): index.html's metas, the web manifest and its icons.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const html = read('../index.html')
const manifest = JSON.parse(read('../public/manifest.webmanifest'))

const metas = (name: string) =>
  [...html.matchAll(/<meta\s+name="([^"]+)"\s+content="([^"]*)"/g)]
    .filter((m) => m[1] === name)
    .map((m) => m[2])

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): [number, number] {
  const buf = readFileSync(new URL(path, import.meta.url))
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG')
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
}

describe('index.html', () => {
  test('has one viewport meta that covers the notch', () => {
    const viewports = metas('viewport')
    expect(viewports).toHaveLength(1)
    const parts = viewports[0].split(',').map((s) => s.trim())
    expect(parts).toEqual(
      expect.arrayContaining(['width=device-width', 'initial-scale=1', 'viewport-fit=cover', 'user-scalable=no'])
    )
    expect(viewports[0]).not.toMatch(/height=device-height|target-densitydpi/)
  })

  test('runs as a home-screen app with the status bar over the scene', () => {
    expect(metas('apple-mobile-web-app-capable')).toEqual(['yes'])
    expect(metas('apple-mobile-web-app-status-bar-style')).toEqual(['black-translucent'])
    expect(metas('theme-color')).toEqual([manifest.theme_color])
    expect(html).toMatch(/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"/)
  })
})

describe('manifest.webmanifest', () => {
  test('opens without browser chrome, scoped to wherever it is served', () => {
    expect(['standalone', 'fullscreen']).toContain(manifest.display)
    // Relative to the manifest's URL, so it stays inside vite's /tides/ base.
    expect(manifest.start_url).toBe('./')
    expect(manifest.scope).toBe('./')
  })

  test('lists 192 and 512 px icons that exist at those sizes', () => {
    const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes)
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']))
    for (const icon of manifest.icons as { src: string; sizes: string }[]) {
      const path = `../public/${icon.src}`
      expect(existsSync(new URL(path, import.meta.url))).toBe(true)
      expect(pngSize(path).join('x')).toBe(icon.sizes)
    }
  })
})
