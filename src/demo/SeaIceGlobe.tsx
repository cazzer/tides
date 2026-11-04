// The seasons tour's sea ice on the globe (tides-zec.19), main view only:
// NSIDC's 2025 sea ice (sea-ice.ts) for the sim date's day of the year, drawn
// as a thin shell over both polar seas. Mounted as a child of Earth's
// OrbitingBody (solar-system.tsx), so it sits in the tilted, spinning frame
// with the globe, and lit by the scene's Sun like the ground (a Lambert
// material), so the polar night hides the ice as it hides the ground.
//
// The day map paints the Arctic Ocean as ice all year; where the year's ice
// is gone the layer repaints it as open water (the mask's green), elsewhere
// it only adds ice over the sea (the mask's red: the elevation map's 0 m).
// The grids are 25 km cells, blended between the two weekly frames either
// side of the date (uMix), so a year played fast grows and melts smoothly.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../store'
import { useSeaIce, type SeaIceData } from './sea-ice-data'
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
vec2 iceMask = texture2D(uIceMask, vec2(iceLon / (2.0 * ICE_PI) + 0.5, maskV)).rg;
// Over sea: the year's ice, and open water over the day map's all-year ice.
float iceAlpha = iceMask.r * max(cover, iceMask.g);
if (iceAlpha < 0.004) discard;
diffuseColor.rgb = mix(uOceanColor, uIceColor, cover / max(max(cover, iceMask.g), 1e-3));
diffuseColor.a = iceAlpha;
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

function createIceMaterial(textures: IceTextures, mix: { value: number }) {
  const material = new THREE.MeshLambertMaterial({ transparent: true, depthWrite: false })
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uIceMask: { value: textures.mask },
      uNorthA: { value: textures.northA },
      uNorthB: { value: textures.northB },
      uSouthA: { value: textures.southA },
      uSouthB: { value: textures.southB },
      uIceMix: mix,
      uIceColor: { value: linear(ICE_SRGB) },
      uOceanColor: { value: linear(OCEAN_SRGB) },
    })
    shader.vertexShader = VERTEX_HEAD + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvIceDir = position;')
    shader.fragmentShader = FRAGMENT_HEAD + shader.fragmentShader.replace('#include <map_fragment>', FRAGMENT_BODY)
  }
  material.customProgramCacheKey = () => 'seasons-sea-ice'
  return material
}

// Module level, so the textures are written outside the hook: the weekly
// frames either side of the sim date into A and B, only when they change.
function showDate(data: SeaIceData, textures: IceTextures, mix: { value: number }, shown: { a: number; b: number }) {
  const t = useStore.getState().timestamp ?? Date.now()
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

export function SeaIceGlobe({ radius }: { radius: number }) {
  const data = useSeaIce()
  return data ? <SeaIceShell radius={radius} data={data} /> : null
}

function SeaIceShell({ radius, data }: { radius: number; data: SeaIceData }) {
  const textures = useMemo(() => createIceTextures(data), [data])
  const mix = useMemo(() => ({ value: 0 }), [])
  const material = useMemo(() => createIceMaterial(textures, mix), [textures, mix])
  const shown = useRef({ a: -1, b: -1 })
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

  useFrame(() => showDate(data, textures, mix, shown.current))

  return (
    <>
      <mesh geometry={caps.north} material={material} raycast={noRaycast} />
      <mesh geometry={caps.south} material={material} raycast={noRaycast} />
    </>
  )
}
