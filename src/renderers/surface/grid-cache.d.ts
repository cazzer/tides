// The terrain plugin's elevation grid cache in 3d-tiles-renderer 0.5.3
// (tides-zmw.9.2), reached through the package's ./src/* export, which
// ships no declaration for it: terrain-internals.ts subclasses it. A
// DataCache keyed (x, y, level) whose items are padded float DataTextures.
// A script (no top-level import), so this declares the module outright
// rather than augmenting one.
declare module '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/GridCache.js' {
  type DataTexture = import('three').DataTexture
  export class GridCache {
    constructor(plugin: unknown)
    plugin: unknown
    cache: Record<string, unknown>
    count: number
    lock(x: number, y: number, level: number): DataTexture | Promise<DataTexture>
    get(x: number, y: number, level: number): DataTexture | Promise<DataTexture> | null
    release(x: number, y: number, level: number): void
    fetchItem(keys: [number, number, number], signal: AbortSignal): Promise<DataTexture>
    disposeItem(grid: DataTexture | null): void
    stitchNeighbors(grid: DataTexture, x: number, y: number, level: number): void
    forEachItem(callback: (grid: DataTexture, keys: [number, number, number]) => void): void
    dispose(): void
  }
}
