// What the ship view's warm-up (ShipWarmup.tsx) does ahead of a body's first
// sight (tides-01v.16): three uploads a texture and links a program on the
// first draw that uses them, and the planets sit outside the view, unused,
// until the ship turns to them.
import * as THREE from 'three'

/** One piece of first-draw work, done ahead of time: a map's upload, or an
 * object's program, or with `side` and `defines`, the program its material
 * turns to later (warmSides, warmDefines). */
export type Warmup =
  | { texture: THREE.Texture }
  | { object: THREE.Object3D; side?: THREE.Side; defines?: readonly string[] }

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
 * Faces a material turns to on its own at draw time, past the warm-up's
 * reach, whose programs it warms too: listed by the material as
 * userData.warmSides (Earth's cloud shell turns to its back faces within
 * the ship's reach of it: cloudShaders.ts, tides-01v.8.4).
 */
function warmSides(material: THREE.Material): THREE.Side[] {
  return (material.userData.warmSides as THREE.Side[] | undefined) ?? []
}

/**
 * Defines a material turns on or off on its own at draw time, whose
 * programs it warms too, on each side it draws: listed as
 * userData.warmDefines (Earth's cloud shell draws typed real-weather maps
 * with CLOUD_TYPED: cloudShaders.ts, tides-tvr.4.2).
 */
function warmDefines(material: THREE.Material): string[] {
  return (material.userData.warmDefines as string[] | undefined) ?? []
}

/** What has been warmed: textures once, materials at a version. */
export interface Warmed {
  textures: WeakSet<THREE.Texture>
  /** Keyed by materialKey (coldWork). */
  materials: WeakMap<object, number>
}

export function createWarmed(): Warmed {
  return { textures: new WeakSet(), materials: new WeakMap() }
}

/**
 * The work three would do on first drawing `scene`'s visible objects that
 * isn't in `warmed` yet, adding it there: each loaded texture once (render
 * targets' textures are uploaded by drawing to them), and each object whose
 * material is new or has changed since (a new map, say, can change its
 * program). Materials are keyed by `materialKey`: three's per-renderer record
 * of the material, which a dispose replaces, since a disposed material drops
 * its programs.
 *
 * An object with userData.warmup === false is skipped with everything under
 * it: the streamed surface tiles (tides-zmw.9.2), which come and go by the
 * dozen a second and upload their own grids. Queued here, a tile's map could
 * be uploaded after the tile was dropped and its bitmap closed (a WebGL
 * INVALID_VALUE per map, seen in a headless low descent).
 */
export function coldWork(
  scene: THREE.Object3D,
  warmed: Warmed,
  materialKey: (material: THREE.Material) => object
): Warmup[] {
  const work: Warmup[] = []
  const visit = (object: THREE.Object3D) => {
    if (!object.visible || object.userData.warmup === false) return
    check(object)
    for (const child of object.children) visit(child)
  }
  const check = (object: THREE.Object3D) => {
    let cold = false
    const sides = new Set<THREE.Side>()
    const toggles = new Set<string>()
    for (const material of materialsOf(object)) {
      for (const texture of texturesOf(material)) {
        if (texture.version === 0 || texture.isRenderTargetTexture || warmed.textures.has(texture)) continue
        warmed.textures.add(texture)
        work.push({ texture })
      }
      const key = materialKey(material)
      if (warmed.materials.get(key) === material.version) continue
      warmed.materials.set(key, material.version)
      cold = true
      for (const side of warmSides(material)) sides.add(side)
      for (const define of warmDefines(material)) toggles.add(define)
    }
    if (cold) work.push({ object })
    for (const side of sides) work.push({ object, side })
    if (toggles.size > 0) {
      const defines = [...toggles]
      work.push({ object, defines })
      for (const side of sides) work.push({ object, side, defines })
    }
  }
  visit(scene)
  return work
}

/**
 * Compiles `object`'s materials turned to `side` (undefined: as they are),
 * with `defines` turned over (each on where it is off, off where it is on),
 * then turns them back. three keeps a material's programs by key, so the
 * draw that turns it so later finds that program linked. Compiling makes it
 * the material's current program, though, and three's draw doesn't check
 * the side or defines again while the version holds: the version moves on,
 * and `warmed` with it.
 */
export function compileSide(
  renderer: Pick<THREE.WebGLRenderer, 'compile'>,
  object: THREE.Object3D,
  side: THREE.Side | undefined,
  camera: THREE.Camera,
  scene: THREE.Scene,
  warmed: Warmed,
  materialKey: (material: THREE.Material) => object,
  defines: readonly string[] = []
): void {
  const materials = materialsOf(object)
  const sides = materials.map((material) => material.side)
  // Kept whole: three keys a program by its defines in their order, so
  // turning one back by adding it again would key a program nothing compiled.
  const owns = materials.map((material) => {
    const own = (material as THREE.ShaderMaterial).defines
    return own ? { ...own } : undefined
  })
  for (const material of materials) {
    if (side !== undefined) material.side = side
    const own = (material as THREE.ShaderMaterial).defines
    if (!own) continue
    for (const define of defines) {
      if (define in own) delete own[define]
      else own[define] = ''
    }
  }
  try {
    renderer.compile(object, camera, scene)
  } finally {
    materials.forEach((material, i) => {
      material.side = sides[i]
      const own = (material as THREE.ShaderMaterial).defines
      const was = owns[i]
      if (own && was) {
        for (const define of Object.keys(own)) delete own[define]
        Object.assign(own, was)
      }
      material.needsUpdate = true
      if (warmed.materials.has(materialKey(material))) {
        warmed.materials.set(materialKey(material), material.version)
      }
    })
  }
}
