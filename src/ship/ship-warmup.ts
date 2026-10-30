// What the ship view's warm-up (ShipWarmup.tsx) does ahead of a body's first
// sight (tides-01v.16): three uploads a texture and links a program on the
// first draw that uses them, and the planets sit outside the view, unused,
// until the ship turns to them.
import * as THREE from 'three'

/**
 * A program an object's draw needs that no drawn object's material holds
 * yet, compiled ahead through a stand-in: `object`, kept out of the scene,
 * against `scene`'s lights and fog (default: the warm-up's scene) into
 * `target` (default: as it is; three keys the tone mapping and output colour
 * space by the target drawn into). Listed by an object as
 * userData.warmProbes, a function called when the work runs (tides-tvr.7.4):
 * the ground's flight variant, a pass drawn off-scene into a target.
 */
export interface WarmProbe {
  object: THREE.Object3D
  scene?: THREE.Object3D
  target?: THREE.WebGLRenderTarget | null
}

/** One piece of first-draw work, done ahead of time: a map's upload, or an
 * object's program, or with `side` and `defines`, the program its material
 * turns to later (warmSides, warmDefines), or the probes `owner` lists. */
export type Warmup =
  | { texture: THREE.Texture }
  | { object: THREE.Object3D; side?: THREE.Side; defines?: readonly string[] }
  | { owner: THREE.Object3D; probes: () => WarmProbe[] }

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

/**
 * The object's probes (WarmProbe), or null. On the object, not its
 * material: three's Material.copy copies userData through JSON, which drops
 * a function (and would choke on a mesh).
 */
function warmProbes(object: THREE.Object3D): (() => WarmProbe[]) | null {
  const probes: unknown = object.userData.warmProbes
  return typeof probes === 'function' ? (probes as () => WarmProbe[]) : null
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
    const probes = cold ? warmProbes(object) : null
    if (probes) work.push({ owner: object, probes })
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

type WarmupRenderer = Pick<THREE.WebGLRenderer, 'compile' | 'initTexture' | 'getRenderTarget' | 'setRenderTarget'>

/**
 * Does `item` (from coldWork) for `camera` in `scene`, skipping an object
 * (or a probes' owner) that unmounted while it waited. Only from a frame
 * callback that runs before the View renders: three's compile replaces the
 * renderer's render state, so it must not run mid-render (an
 * onBeforeRender).
 */
export function runWarmup(
  renderer: WarmupRenderer,
  item: Warmup,
  camera: THREE.Camera,
  scene: THREE.Scene,
  warmed: Warmed,
  materialKey: (material: THREE.Material) => object
): void {
  if ('texture' in item) {
    renderer.initTexture(item.texture)
    return
  }
  if ('owner' in item) {
    if (!item.owner.parent) return
    for (const probe of item.probes()) compileProbe(renderer, probe, camera, scene)
    return
  }
  if (!item.object.parent) return
  if (item.side === undefined && !item.defines) renderer.compile(item.object, camera, scene)
  else compileSide(renderer, item.object, item.side, camera, scene, warmed, materialKey, item.defines)
}

function compileProbe(renderer: WarmupRenderer, probe: WarmProbe, camera: THREE.Camera, scene: THREE.Scene) {
  const previous = renderer.getRenderTarget()
  const retarget = probe.target !== undefined
  if (retarget) renderer.setRenderTarget(probe.target)
  try {
    // A bare mesh as the scene, as render(quad, camera) draws it: three
    // takes any object there (its typings say a Scene).
    renderer.compile(probe.object, camera, (probe.scene ?? scene) as THREE.Scene)
  } finally {
    if (retarget) renderer.setRenderTarget(previous)
  }
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

/**
 * The programs `object`'s materials turn their userData.warmDefines to
 * (compileSide()), compiled once a material (by `materialKey`, kept in
 * `done`): for views the ship's warm-up doesn't run in, such as the
 * overview's panels, whose Earth turns its clouds typed (CLOUD_TYPED) on
 * the first frame the forecast's types reach (tides-tvr.4.5).
 */
export function warmDefinesOnce(
  renderer: Pick<THREE.WebGLRenderer, 'compile'>,
  object: THREE.Object3D,
  camera: THREE.Camera,
  scene: THREE.Scene,
  done: WeakSet<object>,
  materialKey: (material: THREE.Material) => object
): void {
  const cold = materialsOf(object).filter((material) => !done.has(materialKey(material)))
  if (cold.length === 0) return
  for (const material of cold) done.add(materialKey(material))
  const defines = [...new Set(cold.flatMap(warmDefines))]
  if (defines.length > 0) compileSide(renderer, object, undefined, camera, scene, createWarmed(), materialKey, defines)
}
