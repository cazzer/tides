// The sea ice on the globe (tides-zec.19), main view only: NSIDC's 2025 sea
// ice (sea-ice.ts) for the sim date's day of the year, drawn as a thin shell
// over both polar seas, in the seasons tour and, under the clouds, outside
// the tours (tides-6ru.1; where, sea-ice-gate.ts). Mounted as a child of
// Earth's OrbitingBody (solar-system.tsx), so it sits in the tilted, spinning
// frame with the globe, and lit by the scene's Sun like the ground (a Lambert
// material), so the polar night hides the ice as it hides the ground.
//
// The day map paints the Arctic Ocean as ice all year; where the year's ice
// is gone the layer repaints it as open water (the mask's green), elsewhere
// it only adds ice over the sea (the mask's red: the elevation map's 0 m).
// The grids are 25 km cells, blended between the two weekly frames either
// side of the date (uMix), so a year played fast grows and melts smoothly.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../store'
import { SEA_ICE_RENDER_ORDER } from '../renderers/earth-shells'
import { composePatches, createEclipseShadow, type EclipseShadow, type MaterialPatch } from '../renderers/eclipseShadow'
import { useLoadedSeaIce, useSeaIce, type SeaIceData } from './sea-ice-data'
import { HUGHES_E, MASK_HEIGHT, MASK_NORTH, MASK_NORTH_ROWS, MASK_PER_DEG, MASK_SOUTH, NORTH_GRID, RHO_SCALE, SOUTH_GRID, seaIceDay, seaIceFrames } from './sea-ice'

// × Earth's radius: clear of the sea, a hair, so no limb rim shows.
const SHELL_LIFT = 1.0015
// sRGB: the day map's own all-year ice, and its open sea at 55-68°N
// (scripts/build-sea-ice.py prints it), so the repainted water matches.
const ICE_SRGB = [0.86, 0.9, 0.95] as const
const OCEAN_SRGB = [0.0774, 0.2186, 0.3016] as const
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
// frames either side of the sim date into A and B, only when they change.
function showDate(t: number, data: SeaIceData, textures: IceTextures, mix: { value: number }, shown: { a: number; b: number }) {
  const { ice } = data
  const frames = seaIceFrames(seaIceDay(t), ice.stepDays, ice.north.frames.length)
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

/**
 * The ice's shell, mounted wherever the globe may draw it (sea-ice-gate.ts
 * seaIceMayShow) and shown while `visible`, so that a tour hiding it keeps
 * its textures and program for the way back. The data is asked for the
 * first time it is visible, after the scene's first frame (tides-6ru.1).
 */
export function SeaIceGlobe({ radius, visible }: { radius: number; visible: boolean }) {
  useSeaIce(visible, { deferred: true })
  const data = useLoadedSeaIce()
  return data ? <SeaIceShell radius={radius} data={data} visible={visible} /> : null
}

function SeaIceShell({ radius, data, visible }: { radius: number; data: SeaIceData; visible: boolean }) {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const eclipse = useMemo(() => createEclipseShadow('earth'), [])
  const textures = useMemo(() => createIceTextures(data), [data])
  const mix = useMemo(() => ({ value: 0 }), [])
  const fade = useMemo(() => ({ value: 1 }), [])
  const material = useMemo(() => createIceMaterial(textures, mix, fade, eclipse.material), [textures, mix, fade, eclipse])
  const shown = useRef({ a: -1, b: -1 })
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
    shown.current = { a: -1, b: -1 }
  }, [textures])
  useEffect(() => {
    if (group.current) return warmIce(gl, group.current, camera, scene, textures, () => setWarm(true))
  }, [gl, camera, scene, textures, material])

  useFrame(({ camera }) => {
    if (group.current) showShell(group.current, camera, radius, visible && warm, { data, textures, mix, fade, shown: shown.current, eclipse })
  })

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

interface ShellState {
  data: SeaIceData
  textures: IceTextures
  mix: { value: number }
  fade: { value: number }
  shown: { a: number; b: number }
  eclipse: EclipseShadow
}

// Each frame: the shell's share by the eye's height, and only while shown,
// the textures for the date and the Moon's shadow. Module level, so the
// uniforms and the group aren't mutated in a hook.
function showShell(shell: THREE.Group, camera: THREE.Camera, radius: number, on: boolean, state: ShellState) {
  const share = on ? eyeFade(shell, camera, radius) : 0
  state.fade.value = share
  shell.visible = share > 0
  if (!shell.visible) return
  const t = useStore.getState().timestamp ?? Date.now()
  showDate(t, state.data, state.textures, state.mix, state.shown)
  state.eclipse.update(t)
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
 * The shell's share by the eye's height: its lift (SHELL_LIFT, ~10 km)
 * floats over the ground with parallax near it, and the eye would pass
 * through it, so it fades out from FADE_TOP_KM down to FADE_BOTTOM_KM.
 * Below, the globe's own map shows (low-tier close-zoom ice is a follow-up;
 * the streamed tiles' ice is tides-5oz).
 */
function eyeFade(shell: THREE.Object3D, camera: THREE.Camera, radius: number): number {
  shell.getWorldPosition(centre)
  shell.getWorldScale(scale)
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
