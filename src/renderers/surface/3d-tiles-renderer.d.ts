// What 3d-tiles-renderer 0.5.3 ships but doesn't type (tides-zmw.9.1): the
// TerrariumMeshPlugin is exported from 3d-tiles-renderer/three/plugins at
// runtime without a declaration, and ImageOverlay's fetch (the hook every
// overlay download goes through, which SurfaceImageryOverlay overrides) is
// an untyped internal. Pinned to 0.5.3 (package.json; terrain-internals.test.ts
// fails on another version): recheck these on any bump.
import type { ImageOverlay as _ImageOverlay } from '3d-tiles-renderer/three/plugins'

declare module '3d-tiles-renderer/three/plugins' {
  export class TerrariumMeshPlugin {
    constructor(options: {
      url: string
      tileDimension?: number
      maxZoom?: number
      heightScale?: number
      overlay?: _ImageOverlay | null
      applyOverlayTexture?: boolean
      unlit?: boolean
      projection?: 'ellipsoid' | 'source' | string
      endCaps?: boolean
      useRecommendedSettings?: boolean
    })
    name: string
    heightScale: number
    /** Metres above the ellipsoid at (lat, lon) radians, or null before its tile loads. */
    sampleCartographicElevation(lat: number, lon: number): number | null
    dispose(): void
  }
}

declare module '3d-tiles-renderer/src/three/plugins/images/ImageOverlayPlugin.js' {
  interface ImageOverlay {
    fetch(url: string, options?: RequestInit): Promise<Response>
  }
}

// The tiles a composed overlay region draws (imagery.test.ts holds
// SurfaceImageryOverlay's composedFrom to it).
declare module '3d-tiles-renderer/src/three/plugins/images/overlays/utils.js' {
  export function forEachTileInBounds(
    range: readonly number[],
    level: number,
    tiling: unknown,
    callback: (x: number, y: number, level: number) => void
  ): void
}
