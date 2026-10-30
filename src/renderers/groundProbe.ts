// A stand-in for the ground's flight program (tides-tvr.7.4): the ground
// turns to it on the frame flight detail starts (close zoom's descent past
// its barrier), a fresh link of the full Phong program with every patch,
// some 200 ms where the driver links at first use. The warm-ups compile the
// stand-in ahead (ship-warmup.ts WarmProbe); three shares a program between
// materials by cache key, so the ground finds it linked, and still runs its
// own onBeforeCompile, which binds its own uniforms.
import * as THREE from 'three'
import type { MaterialPatch } from './eclipseShadow'

export type GroundProbe = THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhongMaterial>

export function createGroundProbe(): GroundProbe {
  return new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshPhongMaterial())
}

/**
 * Makes `probe` key the program `ground` (drawing `material`) would draw
 * with `patch`: its geometry, its material copied, and the patch, which
 * Material.copy leaves (onBeforeCompile and the cache key are the
 * material's own functions); the probe's material moves on a version, so
 * three keys it afresh.
 */
export function syncGroundProbe(
  probe: GroundProbe,
  ground: THREE.Mesh,
  material: THREE.MeshPhongMaterial,
  patch: MaterialPatch
): void {
  probe.geometry = ground.geometry
  probe.receiveShadow = ground.receiveShadow
  probe.castShadow = ground.castShadow
  const stand = probe.material
  stand.copy(material)
  stand.defines = material.defines ? { ...material.defines } : undefined
  stand.onBeforeCompile = patch.onBeforeCompile
  stand.customProgramCacheKey = patch.customProgramCacheKey
  stand.needsUpdate = true
}
