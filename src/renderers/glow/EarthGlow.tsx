import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { CITY_LIGHTS_COLOR, CITY_LIGHTS_INTENSITY } from '../../lighting'
import { NIGHT_LIGHTS_GLSL } from '../nightLights'
import { GLOW_LAYER, GLOW_SCALE } from './glow'
import { GLOW_ORDER, glowOn, useGlowSource } from './glowSources'

/** [TUNE] The city lights' glow against their own emission. */
const CITY_GLOW_GAIN = 2.2
/** [TUNE] The sea glint's glow at the highlight's peak, linear. */
const GLINT_GLOW_PEAK = 4
/** The glint's Blinn-Phong exponent: the hot core in the middle of the
 * drawn sheen (water.ts roughens it by the wind), which is what blooms. */
const GLINT_GLOW_SHININESS = 900
/** Cloud cover (the map's G, as cloudShaders.ts cloudColumn reads it) over
 * which the glow under it is mostly gone. */
const GLOW_CLOUD_COVER: readonly [number, number] = [0.35, 0.95]
/** Of the glow, what the thickest cloud lets through. */
const GLOW_CLOUD_FLOOR = 0.25

const f = (x: number) => x.toFixed(6)

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNightLightsDir;
  varying vec3 vNormalWorld;
  varying vec3 vToEye;
  varying vec3 vViewPosition;
  varying vec3 vNormalView;
  void main() {
    vUv = uv;
    vNormalView = normalize(normalMatrix * normal);
    vNightLightsDir = position;
    vNormalWorld = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vToEye = cameraPosition - world.xyz;
    vec4 mv = viewMatrix * world;
    vViewPosition = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`

const fragmentShader = /* glsl */ `
  #define PI 3.141592653589793
  #define PI2 6.283185307179586
  uniform sampler2D emissiveMap;
  uniform sampler2D tSea;
  uniform sampler2D uCloudMap;
  uniform float uCloudShift;
  uniform float uClouds;
  uniform vec3 uNightLightsSun;
  uniform vec3 uLights;
  uniform vec3 uSunWorld;
  varying vec2 vUv;
  varying vec3 vNightLightsDir;
  varying vec3 vNormalWorld;
  varying vec3 vToEye;
  varying vec3 vViewPosition;
  varying vec3 vNormalView;
  ${NIGHT_LIGHTS_GLSL.fadeHead}
  void main() {
    vec3 up = normalize(vNightLightsDir);
    float sunUp = dot(up, uNightLightsSun);

    // The lights as the ground draws them (nightLights.ts): on through civil
    // twilight, faded out in flight as their texels magnify. The footprint
    // is the glow target's, a 1/GLOW_SCALE of a View pixel per side.
    vec3 nightFadeDx = dFdx(vViewPosition) * ${f(GLOW_SCALE)};
    vec3 nightFadeDy = dFdy(vViewPosition) * ${f(GLOW_SCALE)};
    vec3 nightFadeUp = normalize(vNormalView);
    float nightFadeWidth = float(textureSize(emissiveMap, 0).x);
    float nightFadeScale = nightFadeWidth / (PI2 * length(vNightLightsDir));
    float nightFadePixel = nightLightsNarrow(
      (nightFadeDx - nightFadeUp * dot(nightFadeUp, nightFadeDx)) * nightFadeScale,
      (nightFadeDy - nightFadeUp * dot(nightFadeUp, nightFadeDy)) * nightFadeScale);
    vec3 lights = texture2D(emissiveMap, vUv).rgb * uLights
      * smoothstep(0.035, -0.1, sunUp)
      * nightLightsFade(nightFadePixel, nightFadeWidth, 0.0);

    // The Sun's glint on water: the hot core of its reflection.
    vec3 n = normalize(vNormalWorld);
    vec3 h = normalize(uSunWorld + normalize(vToEye));
    float sea = texture2D(tSea, vUv).r;
    float glint = sea * pow(max(dot(n, h), 0.0), ${f(GLINT_GLOW_SHININESS)})
      * smoothstep(0.0, 0.08, dot(n, uSunWorld)) * ${f(GLINT_GLOW_PEAK)};

    // Under cloud both are hidden, as the deck hides them on screen.
    vec2 st = vec2(fract(vUv.x - uCloudShift), vUv.y);
    float cover = texture2D(uCloudMap, st).g * uClouds;
    float through = mix(1.0, ${f(GLOW_CLOUD_FLOOR)},
      smoothstep(${f(GLOW_CLOUD_COVER[0])}, ${f(GLOW_CLOUD_COVER[1])}, cover));

    gl_FragColor = vec4((lights + vec3(1.0, 0.97, 0.9) * glint) * through, 1.0);
  }
`

export interface EarthGlowProps {
  geometry: THREE.BufferGeometry
  /** The ground's night map and its water (specular) mask. */
  lightsMap: THREE.Texture
  seaMask: THREE.Texture
  /** The cloud layer's map and its drift. */
  cloudMap: THREE.IUniform<THREE.Texture | null>
  cloudShift: THREE.IUniform<number>
  /** Whether the cloud deck is drawn. */
  clouds: boolean
}

/**
 * Earth in the glow layer (tides-64u.3): its city lights and the Sun's glint
 * on the sea, on the ground's own sphere, so both bloom past their edges.
 * The sphere also hides whatever glows behind Earth. Mount as the ground
 * mesh's sibling, in the same frame.
 */
export function EarthGlow(props: EarthGlowProps) {
  return glowOn() ? <EarthGlowOn {...props} /> : null
}

// Module level, so hooks don't mutate a memoised material in place.
function setInputs(material: THREE.ShaderMaterial, lightsMap: THREE.Texture, seaMask: THREE.Texture, clouds: boolean) {
  material.uniforms.emissiveMap.value = lightsMap
  material.uniforms.tSea.value = seaMask
  material.uniforms.uClouds.value = clouds ? 1 : 0
}

const position = new THREE.Vector3()
const turn = new THREE.Quaternion()
const scale = new THREE.Vector3()

// The Sun's direction for this draw, from the stand-in's own world matrix
// (the ground's frame): the Sun is the scene's origin, as sunInEarthFrame
// (EarthRenderer.tsx) has it. Not the cloud layer's uniform, which the
// View's scene render sets after the glow has drawn.
function setSun(material: THREE.ShaderMaterial, mesh: THREE.Object3D) {
  mesh.matrixWorld.decompose(position, turn, scale)
  const world = material.uniforms.uSunWorld.value as THREE.Vector3
  world.copy(position).negate().normalize()
  ;(material.uniforms.uNightLightsSun.value as THREE.Vector3).copy(world).applyQuaternion(turn.invert())
}

const lightsColor = new THREE.Color(CITY_LIGHTS_COLOR).multiplyScalar(CITY_LIGHTS_INTENSITY * CITY_GLOW_GAIN)
const sunWorld = new THREE.Vector3()

function EarthGlowOn({ geometry, lightsMap, seaMask, cloudMap, cloudShift, clouds }: EarthGlowProps) {
  const mesh = useRef<THREE.Mesh>(null)
  useGlowSource(mesh, GLOW_ORDER.opaque)
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          emissiveMap: { value: lightsMap },
          tSea: { value: seaMask },
          uCloudMap: cloudMap,
          uCloudShift: cloudShift,
          uClouds: { value: clouds ? 1 : 0 },
          uNightLightsSun: { value: new THREE.Vector3(1, 0, 0) },
          uLights: { value: lightsColor },
          uSunWorld: { value: sunWorld.clone() },
        },
        toneMapped: false,
      }),
    // Uniform objects are shared, never rebuilt: see the memo's inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  useLayoutEffect(() => setInputs(material, lightsMap, seaMask, clouds), [material, lightsMap, seaMask, clouds])
  useEffect(() => () => material.dispose(), [material])

  return (
    <mesh
      ref={mesh}
      layers={GLOW_LAYER}
      geometry={geometry}
      material={material}
      raycast={() => null}
      onBeforeRender={() => {
        if (mesh.current) setSun(material, mesh.current)
      }}
    />
  )
}
