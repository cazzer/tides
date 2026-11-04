// The sea ice on the globe (tides-zec.19): NSIDC's 2025 sea ice (sea-ice.ts)
// for the sim date's day of the year, on the main view and in ship mode
// (tides-6ru.1, tides-6ru.2; where, sea-ice-gate.ts). The ground's shader
// draws it (renderers/seaIceGround.ts), under the clouds and their shadows,
// at any height and on every tier, and the streamed tiles near the ground
// (renderers/surface/tile-ice.ts), both from the sea texture's layers
// (renderers/seaIceLayers.ts) this keeps on the date. In the seasons tour a
// thin shell over both polar seas draws it from afar, the tour's look, lit
// by the scene's Sun like the ground (a Lambert material), so the polar
// night hides the ice as it hides the ground. Mounted as a child of Earth's
// OrbitingBody (solar-system.tsx), so it sits in the tilted, spinning frame
// with the globe.
//
// The day map paints the Arctic Ocean as ice all year; where the year's ice
// is gone the layer repaints it as open water (the mask's green), elsewhere
// it only adds ice over the sea (the mask's red: the elevation map's 0 m).
// The grids are 25 km cells, blended between the two weekly frames either
// side of the date (uMix), so a year played fast grows and melts smoothly.
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../store'
import { SURFACE_TILES_ON } from '../surface'
import { SEA_ICE_RENDER_ORDER } from '../renderers/earth-shells'
import { composePatches, createEclipseShadow, type EclipseShadow, type MaterialPatch } from '../renderers/eclipseShadow'
import { attachSeaIce, seaIceSurface, showSeaIceFrames } from '../renderers/seaIceLayers'
import { globeStencil } from '../renderers/surface/surface-scale'
import { useLoadedSeaIce, useSeaIce, type SeaIceData } from './sea-ice-data'
import { HUGHES_E, ICE_SRGB, MASK_HEIGHT, MASK_NORTH, MASK_NORTH_ROWS, MASK_PER_DEG, MASK_SOUTH, NORTH_GRID, OCEAN_SRGB, RHO_SCALE, SOUTH_GRID, seaIceDay, seaIceFrames } from './sea-ice'

// × Earth's radius: clear of the sea, a hair, so no limb rim shows.
const SHELL_LIFT = 1.0015
// The caps' reach from each pole (deg of colatitude), to the mask's edges.
const NORTH_CAP = 90 - MASK_NORTH.bottom
const SOUTH_CAP = 90 + MASK_SOUTH.top

function noRaycast() {}

function linear(srgb: readonly number[]) {
  return new THREE.Color().setRGB(srgb[0], srgb[1], srgb[2], THREE.SRGBColorSpace)
}

function gridTexture(width: number, height: number) {
  const texture = new THREE.DataTexture(new Uint8Array(width * height), width, height, THREE.RedFormat, THREE.UnsignedByteType)
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

const VERTEX_HEAD = /* glsl */ `
varying vec3 vIceDir;
`
const FRAGMENT_HEAD = /* glsl */ `
varying vec3 vIceDir;
uniform sampler2D uIceMask;
uniform sampler2D uNorthA;
uniform sampler2D uNorthB;
uniform sampler2D uSouthA;
uniform sampler2D uSouthB;
uniform float uIceMix;
uniform float uIceFade;
uniform vec3 uIceColor;
uniform vec3 uOceanColor;
const float ICE_PI = 3.141592653589793;
const float ICE_E = ${HUGHES_E.toFixed(9)};
const float ICE_RHO = ${RHO_SCALE.toFixed(3)};

// Cells from the grid's top-left corner over its size: NSIDC's polar
// stereographic (sea-ice.ts gridPoint), the south's the north's turned over.
vec2 iceGridUv(float sgn, float lon0, vec2 corner, vec2 size, float lat, float lon) {
  float phi = sgn * lat;
  float lam = sgn * (lon - lon0);
  float s = ICE_E * sin(phi);
  float rho = ICE_RHO * tan(ICE_PI / 4.0 - phi / 2.0) / pow((1.0 - s) / (1.0 + s), ICE_E / 2.0);
  vec2 xy = vec2(sgn * rho * sin(lam), -sgn * rho * cos(lam));
  return vec2(xy.x - corner.x, corner.y - xy.y) / 25000.0 / size;
}

float iceCover(sampler2D a, sampler2D b, vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  return mix(texture2D(a, uv).r, texture2D(b, uv).r, uIceMix);
}
`
const DEG = Math.PI / 180
const FRAGMENT_BODY = /* glsl */ `
vec3 iceDir = normalize(vIceDir);
float iceLat = asin(clamp(iceDir.y, -1.0, 1.0));
float iceLon = atan(-iceDir.z, iceDir.x);
float iceLatDeg = iceLat * ${(1 / DEG).toFixed(9)};
float cover;
float maskV;
if (iceLatDeg >= ${MASK_NORTH.bottom.toFixed(1)}) {
  cover = iceCover(uNorthA, uNorthB, iceGridUv(1.0, ${(NORTH_GRID.lon0 * DEG).toFixed(9)}, vec2(${NORTH_GRID.x0.toFixed(1)}, ${NORTH_GRID.y0.toFixed(1)}), vec2(${NORTH_GRID.width.toFixed(1)}, ${NORTH_GRID.height.toFixed(1)}), iceLat, iceLon));
  maskV = (${MASK_NORTH.top.toFixed(1)} - iceLatDeg) / ${(MASK_NORTH.top - MASK_NORTH.bottom).toFixed(1)} * ${(MASK_NORTH_ROWS / MASK_HEIGHT).toFixed(9)};
} else if (iceLatDeg <= ${MASK_SOUTH.top.toFixed(1)}) {
  cover = iceCover(uSouthA, uSouthB, iceGridUv(-1.0, ${(SOUTH_GRID.lon0 * DEG).toFixed(9)}, vec2(${SOUTH_GRID.x0.toFixed(1)}, ${SOUTH_GRID.y0.toFixed(1)}), vec2(${SOUTH_GRID.width.toFixed(1)}, ${SOUTH_GRID.height.toFixed(1)}), iceLat, iceLon));
  maskV = (${MASK_NORTH_ROWS.toFixed(1)} + (${MASK_SOUTH.top.toFixed(1)} - iceLatDeg) * ${MASK_PER_DEG.toFixed(1)}) / ${MASK_HEIGHT.toFixed(1)};
} else {
  discard;
}
// The mask's u wraps at the antimeridian, where its jump would pick the
// smallest mip, a seam to the pole (tides-6ru.1): the mip goes by the
// smaller of its slope and that of u cut half a turn away.
float iceU = iceLon / (2.0 * ICE_PI) + 0.5;
float iceUCut = fract(iceU + 0.5);
float iceDux = abs(dFdx(iceU)) < abs(dFdx(iceUCut)) ? dFdx(iceU) : dFdx(iceUCut);
float iceDuy = abs(dFdy(iceU)) < abs(dFdy(iceUCut)) ? dFdy(iceU) : dFdy(iceUCut);
vec2 iceMask = textureGrad(uIceMask, vec2(iceU, maskV), vec2(iceDux, dFdx(maskV)), vec2(iceDuy, dFdy(maskV))).rg;
// Over sea: the year's ice, and open water over the day map's all-year ice.
float iceAlpha = iceMask.r * max(cover, iceMask.g);
if (iceAlpha < 0.004) discard;
diffuseColor.rgb = mix(uOceanColor, uIceColor, cover / max(max(cover, iceMask.g), 1e-3));
diffuseColor.a = iceAlpha * uIceFade;
`

interface IceTextures {
  northA: THREE.DataTexture
  northB: THREE.DataTexture
  southA: THREE.DataTexture
  southB: THREE.DataTexture
  mask: THREE.DataTexture
}

function createIceTextures({ ice, mask }: SeaIceData): IceTextures {
  const maskTexture = new THREE.DataTexture(mask.rg, mask.width, mask.height, THREE.RGFormat, THREE.UnsignedByteType)
  maskTexture.wrapS = THREE.RepeatWrapping
  maskTexture.magFilter = THREE.LinearFilter
  maskTexture.minFilter = THREE.LinearMipmapLinearFilter
  maskTexture.generateMipmaps = true
  maskTexture.needsUpdate = true
  return {
    northA: gridTexture(ice.north.width, ice.north.height),
    northB: gridTexture(ice.north.width, ice.north.height),
    southA: gridTexture(ice.south.width, ice.south.height),
    southB: gridTexture(ice.south.width, ice.south.height),
    mask: maskTexture,
  }
}

function createIceMaterial(textures: IceTextures, mix: { value: number }, fade: { value: number }, eclipse: MaterialPatch) {
  const material = new THREE.MeshLambertMaterial({ transparent: true, depthWrite: false })
  // Only where no streamed tile drew: the tiles draw the ice themselves
  // (renderers/surface/tile-ice.ts), so the shell never floats over them.
  globeStencil(material, SURFACE_TILES_ON)
  const ice: MaterialPatch = {
    onBeforeCompile(shader) {
      Object.assign(shader.uniforms, {
        uIceMask: { value: textures.mask },
        uNorthA: { value: textures.northA },
        uNorthB: { value: textures.northB },
        uSouthA: { value: textures.southA },
        uSouthB: { value: textures.southB },
        uIceMix: mix,
        uIceFade: fade,
        uIceColor: { value: linear(ICE_SRGB) },
        uOceanColor: { value: linear(OCEAN_SRGB) },
      })
      shader.vertexShader = VERTEX_HEAD + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvIceDir = position;')
      shader.fragmentShader = FRAGMENT_HEAD + shader.fragmentShader.replace('#include <map_fragment>', FRAGMENT_BODY)
    },
    customProgramCacheKey: () => 'seasons-sea-ice',
  }
  // The Moon's shadow on the ice as on the ground (tides-6ru.1).
  const patch = composePatches(ice, eclipse)
  material.onBeforeCompile = patch.onBeforeCompile
  material.customProgramCacheKey = patch.customProgramCacheKey
  return material
}

// Module level, so the textures are written outside the hook: the weekly
// frames either side of the date into A and B, only when they change.
function showDate(frames: Frames, data: SeaIceData, textures: IceTextures, mix: { value: number }, shown: { a: number; b: number }) {
  const { ice } = data
  mix.value = frames.mix
  if (frames.a !== shown.a) {
    shown.a = frames.a
    textures.northA.image.data = ice.north.frames[frames.a]
    textures.southA.image.data = ice.south.frames[frames.a]
    textures.northA.needsUpdate = true
    textures.southA.needsUpdate = true
  }
  if (frames.b !== shown.b) {
    shown.b = frames.b
    textures.northB.image.data = ice.north.frames[frames.b]
    textures.southB.image.data = ice.south.frames[frames.b]
    textures.northB.needsUpdate = true
    textures.southB.needsUpdate = true
  }
}

type Frames = ReturnType<typeof seaIceFrames>

interface SeaIceGlobeProps {
  radius: number
  /** Whether the globe draws the ice now (sea-ice-gate.ts seaIceOnGlobe). */
  visible: boolean
  /** The seasons tour's shell: `mounted` (kept warm, seaIceShellMounts)
   * and `on` (shown, seaIceHidesClouds: the tour's look). */
  shell: { mounted: boolean; on: boolean }
}

/**
 * The date's sea ice, mounted wherever the globe may draw it (sea-ice-gate.ts
 * seaIceMayShow): ship mode too, on every tier. The ground draws it
 * (renderers/seaIceGround.ts) and the streamed tiles near it
 * (renderers/surface/tile-ice.ts), from the layers this keeps on the date
 * each frame while `visible`; in the seasons tour the shell draws it from
 * afar as it always has, the ground taking over as the shell fades out
 * near the ground. The data is asked for the first time it is visible,
 * after the scene's first frame (tides-6ru.1).
 */
export function SeaIceGlobe({ radius, visible, shell }: SeaIceGlobeProps) {
  useSeaIce(visible, { deferred: true })
  const data = useLoadedSeaIce()
  return data ? <SeaIceDriver radius={radius} data={data} visible={visible} shell={shell} /> : null
}

/** What the driver reads of the mounted shell, once it is built. */
interface ShellHandle {
  group: THREE.Group
  textures: IceTextures
  mix: { value: number }
  fade: { value: number }
  shown: { a: number; b: number }
  eclipse: EclipseShadow
  /** Its program linked and its mask uploaded. */
  warm: boolean
}

function SeaIceDriver({ radius, data, visible, shell }: { radius: number; data: SeaIceData } & Omit<SeaIceGlobeProps, 'radius'>) {
  const frame = useRef<THREE.Group>(null)
  const handle = useRef<ShellHandle | null>(null)
  // The layers the ground and the tiles read.
  useEffect(() => attachGround(data), [data])
  useFrame(({ camera }) => {
    if (frame.current) driveIce(frame.current, camera, radius, data, visible, shell.on, shell.mounted ? handle.current : null)
  })
  return (
    <group ref={frame}>
      {shell.mounted && (
        <SeaIceShell
          radius={radius}
          data={data}
          handleRef={handle}
        />
      )}
    </group>
  )
}

// The layers attached for `data`; the release drops the ground's ice too.
// Module level, so the uniforms aren't mutated in a hook.
function attachGround(data: SeaIceData): () => void {
  const release = attachSeaIce(data.ice, data.mask)
  return () => {
    release()
    seaIceSurface.ground.value = 0
  }
}

// Each frame: the date's frames to the layers while the ice shows, and in
// the seasons tour (`shellOn`) the shell's share by the eye's height, the
// ground drawing the ice wherever the shell isn't wholly over it, and not at
// all until the shell is warm (the tour as it was, no other look first).
// Module level, so the uniforms and the groups aren't mutated in a hook.
function driveIce(
  frame: THREE.Object3D,
  camera: THREE.Camera,
  radius: number,
  data: SeaIceData,
  visible: boolean,
  shellOn: boolean,
  mounted: ShellHandle | null
) {
  if (!visible) {
    if (mounted) hideShell(mounted)
    seaIceSurface.ground.value = 0
    // Off: the ground and the streamed tiles drop the ice (tides-5oz).
    showSeaIceFrames(data.ice, null)
    return
  }
  const t = useStore.getState().timestamp ?? Date.now()
  const frames = seaIceFrames(seaIceDay(t), data.ice.stepDays, data.ice.north.frames.length)
  showSeaIceFrames(data.ice, frames)
  const shown = shellOn ? mounted : null
  let share = 0
  if (shown?.warm) {
    share = eyeFade(frame, camera, radius)
    shown.fade.value = share
    shown.group.visible = share > 0
    if (shown.group.visible) {
      showDate(frames, data, shown.textures, shown.mix, shown.shown)
      shown.eclipse.update(t)
    }
  } else if (mounted) {
    hideShell(mounted)
  }
  // Under the fading shell too, so the ice crossfades rather than gaps.
  // With no shell mounted to draw the tour's look, the ground draws the ice.
  seaIceSurface.ground.value = shellOn && mounted ? (shown?.warm && share < 1 ? 1 : 0) : 1
}

function hideShell(shell: ShellHandle) {
  shell.fade.value = 0
  shell.group.visible = false
}

/**
 * The seasons tour's shell (tides-zec.19): the ice as a thin Lambert shell
 * over both polar seas, mounted on the main view (seaIceShellMounts) so its
 * 7 MB mask and program are ready for the tour, shown only in it (the
 * driver sets it each frame through `handleRef`).
 */
function SeaIceShell({ radius, data, handleRef }: { radius: number; data: SeaIceData; handleRef: RefObject<ShellHandle | null> }) {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const eclipse = useMemo(() => createEclipseShadow('earth'), [])
  const textures = useMemo(() => createIceTextures(data), [data])
  const mix = useMemo(() => ({ value: 0 }), [])
  const fade = useMemo(() => ({ value: 1 }), [])
  const material = useMemo(() => createIceMaterial(textures, mix, fade, eclipse.material), [textures, mix, fade, eclipse])
  const group = useRef<THREE.Group>(null)
  // Shown once its program is linked and its mask uploaded.
  const [warm, setWarm] = useState(false)
  // Two caps, as far from each pole as the mask reaches.
  const caps = useMemo(
    () => ({
      north: new THREE.SphereGeometry(radius * SHELL_LIFT, 256, 48, 0, Math.PI * 2, 0, NORTH_CAP * DEG),
      south: new THREE.SphereGeometry(radius * SHELL_LIFT, 256, 48, 0, Math.PI * 2, Math.PI - SOUTH_CAP * DEG, SOUTH_CAP * DEG),
    }),
    [radius]
  )
  useEffect(() => () => Object.values(caps).forEach((geometry) => geometry.dispose()), [caps])
  useEffect(
    () => () => {
      material.dispose()
      Object.values(textures).forEach((texture) => texture.dispose())
    },
    [material, textures]
  )
  useEffect(() => {
    if (group.current) return warmIce(gl, group.current, camera, scene, textures, () => setWarm(true))
  }, [gl, camera, scene, textures, material])
  // Handed to the driver with fresh textures (their frames rewritten).
  useEffect(() => {
    if (!group.current) return
    handleRef.current = { group: group.current, textures, mix, fade, shown: { a: -1, b: -1 }, eclipse, warm }
    return () => {
      handleRef.current = null
    }
  }, [handleRef, textures, mix, fade, eclipse, warm])

  return (
    <group
      ref={group}
      visible={false}
    >
      <mesh renderOrder={SEA_ICE_RENDER_ORDER} geometry={caps.north} material={material} raycast={noRaycast} />
      <mesh renderOrder={SEA_ICE_RENDER_ORDER} geometry={caps.south} material={material} raycast={noRaycast} />
    </group>
  )
}

/**
 * Links the shell's program off the frame (compileAsync) and uploads its
 * mask (7 MB and its mips) now, not on the first frame it shows; calls
 * `done` once linked, or if linking fails (the first draw links it then).
 * Returns the cancel. Module level, so the objects from useThree aren't
 * mutated in a hook.
 */
function warmIce(
  gl: THREE.WebGLRenderer,
  shell: THREE.Group,
  camera: THREE.Camera,
  scene: THREE.Scene,
  textures: IceTextures,
  done: () => void
): () => void {
  let live = true
  gl.initTexture(textures.mask)
  // compile() reads only what is visible.
  shell.visible = true
  const linked = gl.compileAsync(shell, camera, scene)
  shell.visible = false
  const finish = () => {
    if (live) done()
  }
  linked.then(finish, finish)
  return () => {
    live = false
  }
}

/**
 * The shell's share by the eye's height (`frame` in the globe's frame): its
 * lift (SHELL_LIFT, ~10 km) floats over the ground with parallax near it,
 * and the eye would pass through it, so it fades out from FADE_TOP_KM down
 * to FADE_BOTTOM_KM, over the ground's own ice (tides-6ru.2).
 */
function eyeFade(frame: THREE.Object3D, camera: THREE.Camera, radius: number): number {
  frame.getWorldPosition(centre)
  frame.getWorldScale(scale)
  const worldRadius = radius * scale.x
  const heightKm = ((camera.getWorldPosition(eye).distanceTo(centre) - worldRadius) / worldRadius) * EARTH_RADIUS_KM
  return THREE.MathUtils.smoothstep(heightKm, FADE_BOTTOM_KM, FADE_TOP_KM)
}

const EARTH_RADIUS_KM = 6371
const FADE_BOTTOM_KM = 45
const FADE_TOP_KM = 90
const centre = new THREE.Vector3()
const eye = new THREE.Vector3()
const scale = new THREE.Vector3()
