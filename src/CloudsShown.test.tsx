import { renderToStaticMarkup } from 'react-dom/server'
import type * as THREE from 'three'
import { describe, expect, test, vi } from 'vitest'
import type { CloudStatus, FrameView } from './cloud-frames'
import type { CloudSource } from './real-clouds'
import type { RealCloudSnapshot } from './renderers/realCloudTextures'
import { CloudsShown } from './CloudsShown'

const T = Date.parse('2026-10-25T17:00:00Z')

const { state } = vi.hoisted(() => ({ state: { snapshot: null as RealCloudSnapshot | null } }))
vi.mock('./renderers/realCloudTextures', () => ({ useRealCloudSnapshot: () => state.snapshot }))
vi.mock('./store', () => ({
  useStore: (select: (s: { timestamp: number; jumpDate: Date | null }) => unknown) =>
    select({ timestamp: T, jumpDate: null }),
}))

const daily = {
  kind: 'gibs',
  layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
  snowLayer: 'VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1',
  date: '2026-10-25',
} as const
const geo: CloudSource = { kind: 'geo', time: '2026-10-25T17:00:00Z', fallback: daily }
const forecast: CloudSource = { kind: 'forecast', time: '2026-10-25T23:00:00Z', base: geo }

/** The line for one frame at the sim time, with a texture whose userData
 * is `userData` (none while it loads or once it failed). */
function line(source: CloudSource, status: CloudStatus, userData: Record<string, unknown> | null): string {
  const texture = userData ? ({ userData } as unknown as THREE.Texture) : null
  const frame: FrameView<THREE.Texture> = { key: `${source.kind}-1`, timeMs: T, source, status, texture }
  state.snapshot = { frames: [frame], texture, source, status }
  return renderToStaticMarkup(<CloudsShown />)
}

// Which clouds are on screen, as a credits line in settings: with their
// types from Open-Meteo once a typed frame is drawn by type (tides-tvr.4.2).
describe('CloudsShown', () => {
  const satellites = { satellites: ['GOES-18'], time: '2026-10-25T17:00:00Z' }

  test('credits Open-Meteo for the types of a typed frame', () => {
    const html = line(geo, 'ready', { geo: satellites, types: {} })
    expect(html).toContain('NASA GIBS/ESDIS · GOES-18 2026-10-25 17:00 UTC + VIIRS 2026-10-25')
    expect(html).toContain(' · types: Open-Meteo')
    expect(line(forecast, 'ready', { types: {} })).toContain(' · types: Open-Meteo')
  })

  test('says nothing of types for an untyped frame, one loading, or one that failed', () => {
    expect(line(geo, 'ready', { geo: satellites })).not.toContain('Open-Meteo')
    expect(line(geo, 'ready', { geo: satellites, types: null })).not.toContain('Open-Meteo')
    expect(line(geo, 'loading', null)).not.toContain('Open-Meteo')
    expect(line(geo, 'failed', null)).toContain('unavailable')
    expect(line(geo, 'failed', null)).not.toContain('Open-Meteo')
  })
})
