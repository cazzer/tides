// More of 3d-tiles-renderer 0.5.3's ./src/* modules that ship no declaration
// (tides-zmw.9.7): surface-scale.test.ts builds a tile material, its
// geometry and the fade plugin's wrapper from them, to check the patch on
// what the library really makes. A script, like grid-cache.d.ts.
declare module '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/TerrainLambertMaterial.js' {
  import { MeshLambertMaterial } from 'three'
  export class TerrainLambertMaterial extends MeshLambertMaterial {}
}

declare module '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/SkirtedPlaneGeometry.js' {
  import { BufferGeometry } from 'three'
  export class SkirtedPlaneGeometry extends BufferGeometry {
    constructor(width: number, height: number, widthSegments: number, heightSegments: number)
    surfaceVertexCount: number
    skirtSourceIndices: ArrayLike<number>
  }
}

declare module '3d-tiles-renderer/src/three/plugins/fade/wrapFadeMaterial.js' {
  import type { Material } from 'three'
  export function wrapFadeMaterial(
    material: Material,
    previousOnBeforeCompile: Material['onBeforeCompile']
  ): { fadeIn: { value: number }; fadeOut: { value: number } }
}
