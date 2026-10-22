// What the ship view's warm-up (ShipWarmup.tsx) does ahead of a body's first
// sight (tides-01v.16): three uploads a texture and links a program on the
// first draw that uses them, and the planets sit outside the view, unused,
// until the ship turns to them.
import * as THREE from 'three'

/** One piece of first-draw work, done ahead of time. */
export type Warmup = { texture: THREE.Texture } | { object: THREE.Object3D }

function materialsOf(object: THREE.Object3D): THREE.Material[] {
  const { material } = object as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }
  return material ? [material].flat() : []
}

function texturesOf(material: THREE.Material): THREE.Texture[] {
  const uniforms = (material as THREE.ShaderMaterial).uniforms ?? {}
  return [...Object.values(material), ...Object.values(uniforms).map((u) => u?.value)].filter(
    (value): value is THREE.Texture => (value as THREE.Texture | null)?.isTexture === true
  )
}

/**
 * The work three would do on first drawing `scene`'s visible objects that
 * isn't in `warmed` yet, adding it there: each loaded texture once (render
 * targets' textures are uploaded by drawing to them), and each material once
 * per `materialKey`. The key is three's per-renderer record of the material,
 * which a dispose replaces, since a disposed material drops its programs.
 */
export function coldWork(
  scene: THREE.Object3D,
  warmed: WeakSet<object>,
  materialKey: (material: THREE.Material) => object
): Warmup[] {
  const work: Warmup[] = []
  scene.traverseVisible((object) => {
    for (const material of materialsOf(object)) {
      for (const texture of texturesOf(material)) {
        if (texture.version === 0 || texture.isRenderTargetTexture || warmed.has(texture)) continue
        warmed.add(texture)
        work.push({ texture })
      }
      const key = materialKey(material)
      if (warmed.has(key)) continue
      warmed.add(key)
      work.push({ object })
    }
  })
  return work
}
