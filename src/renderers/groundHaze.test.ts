import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer } from './cloudShaders'
import { groundDetailPatch } from './groundDetail'
import {
  createGroundHaze,
  GROUND_HAZE_AIR,
  GROUND_HAZE_E,
  GROUND_HAZE_POWER,
  groundHazeDepth,
  groundHazeWeights,
} from './groundHaze'
import {
  ATMOSPHERE_OUTER,
  ATMOSPHERE_SCALE_HEIGHT,
  ATMOSPHERE_SURFACE,
  groundHazeTop,
  pickShellFaces,
} from './earth-shells'
import { EARTH_GROUND_CLEARANCE } from '../ship/ship-bodies'
import { EARTH_RADIUS_KM } from '../cloud-layer'
import hazeGlsl from '../shaders/atmosphere/haze.glsl'

// The ship's camera is near Earth (limb-detail's view).
vi.mock('../ship/limb-detail', async (original) => ({
  ...(await original<typeof import('../ship/limb-detail')>()),
  limbBody: () => 'earth',
}))

const R = 3
const SURFACE = R * ATMOSPHERE_SURFACE
const H = R * ATMOSPHERE_SCALE_HEIGHT
const GRAZING = Math.sqrt(2 * Math.PI * SURFACE * H)
const V = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z)

// haze.glsl's columns, ported for the seam and the bob below (the first test
// pins the lines they copy).
function hazeAbove(r: number, mu: number): number {
  const x = r / H
  const z = mu * Math.sqrt(0.5 * x)
  return (Math.exp(-(r - SURFACE) / H) * H * Math.sqrt(2 * x)) / (z + Math.sqrt(z * z + 1.2732395))
}

function columnAhead(ro: THREE.Vector3, rd: THREE.Vector3): number {
  const r = Math.max(ro.length(), SURFACE)
  const eye = ro.clone().setLength(r)
  const b = eye.dot(rd)
  const mu = b / r
  if (mu >= 0) return hazeAbove(r, mu)
  const c2 = r * r - b * b
  const p = Math.sqrt(Math.max(c2, 0))
  const line =
    SURFACE * SURFACE - c2 > 0
      ? GRAZING * Math.exp(-(SURFACE - p) / (1.5 * H))
      : GRAZING * Math.sqrt(p / SURFACE) * Math.exp(-(p - SURFACE) / H)
  return Math.max(line - hazeAbove(r, -mu), 0)
}

function columnAheadOverSea(ro: THREE.Vector3, rd: THREE.Vector3): number {
  let column = columnAhead(ro, rd)
  const bSea = ro.dot(rd)
  const hSea = bSea * bSea - (ro.lengthSq() - R * R)
  if (ro.length() < SURFACE && ro.length() > R && bSea < 0 && hSea > 0) {
    const eye = ro.clone().setLength(SURFACE)
    const sea = ro.clone().addScaledVector(rd, -bSea - Math.sqrt(hSea))
    const own = 1 - THREE.MathUtils.smoothstep(hSea / (bSea * bSea), 0, 0.1)
    column = THREE.MathUtils.lerp(columnAhead(eye, sea.sub(eye).normalize()), column, own)
  }
  return column
}

// groundHaze()'s reference ray: tangent to the sphere through the point, in
// the eye's ray's vertical plane.
function reference(eye: THREE.Vector3, ray: THREE.Vector3): THREE.Vector3 {
  const rE = eye.length()
  const rP = eye.clone().add(ray).length()
  const up = eye.clone().divideScalar(rE)
  const dir = ray.clone().normalize()
  const across = dir.clone().addScaledVector(up, -dir.dot(up)).normalize()
  const dip2 = THREE.MathUtils.clamp(((rE - rP) * (rE + rP)) / (rE * rE), 0, 1)
  return across.multiplyScalar(Math.sqrt(1 - dip2)).addScaledVector(up, -Math.sqrt(dip2))
}

// A point at radius rP, s from an eye at (0, rE).
function pointAt(rE: number, rP: number, s: number): THREE.Vector3 {
  const cos = (rE * rE + rP * rP - s * s) / (2 * rE * rP)
  return V(rP * Math.sqrt(1 - cos * cos), rP * cos)
}

function phongShader() {
  return {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
    vertexShader: THREE.ShaderLib.phong.vertexShader,
    fragmentShader: THREE.ShaderLib.phong.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms
}

function cameraAt(r: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.001, 100)
  camera.position.set(r, 0, 0)
  camera.updateMatrixWorld()
  return camera
}

describe('ground haze', () => {
  it("lays the haze over the ground's output, its macros gone before the cloud patch's uSeaLevel", () => {
    const eclipse = createEclipseShadow('earth')
    const clouds = createCloudLayer(eclipse, false)
    const haze = createGroundHaze(clouds.uniforms.uSunDir, R, false)
    const shader = phongShader()
    composePatches(eclipse.material, clouds.groundPatch, groundDetailPatch(false), haze.patch).onBeforeCompile(
      shader,
      {} as THREE.WebGLRenderer
    )
    const frag = shader.fragmentShader
    const at = (s: string) => {
      expect(frag).toContain(s)
      return frag.indexOf(s)
    }
    expect(at('#undef uSeaLevel')).toBeLessThan(at('uniform float uSeaLevel;'))
    expect(at('float columnAheadOverSea(')).toBeLessThan(at('#undef uSeaLevel'))
    expect(frag).toMatch(/#include <colorspace_fragment>\s+if \(uGroundHaze > 0\.0\)/)
    expect(at('#include <opaque_fragment>')).toBeLessThan(at('if (uGroundHaze > 0.0)'))
    expect(shader.vertexShader).toMatch(/#include <project_vertex>\s+vGroundHazeRay =/)
    expect(shader.uniforms.uGroundHazeSun).toBe(clouds.uniforms.uSunDir)
    // The depth and weights groundHazeDepth() and groundHazeWeights()
    // mirror, and the reference ray the tests port: a change to one side
    // fails here.
    for (const line of [
      'return exp(-max(r - uSeaLevel, 0.0) / (uSeaLevel * 0.001256));',
      'float tau = s * (groundHazeDensity(rE) + 4.0 * groundHazeDensity(length(eye + 0.5 * ray)) + groundHazeDensity(rP)) / 6.0;',
      'float grazing = sqrt(6.2831853 * uSurface * uScaleHeight);',
      'vec3 dir = ray / s;',
      'float rP = length(eye + ray);',
      'float reach = tau / uGroundHazeLength;',
      'float share = 1.0 - exp(-reach * reach); // GROUND_HAZE_POWER 2',
      'vec3 across = dir - up * dot(dir, up);',
      'across = a2 > 1e-10 ? across * inversesqrt(a2) : normalize(cross(up, abs(up.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));',
      'float dip2 = clamp((rE - rP) * (rE + rP) / (rE * rE), 0.0, 1.0);',
      'vec3 tangent = across * sqrt(1.0 - dip2) - up * sqrt(dip2);',
      'float column = columnAhead(eye, tangent, grazing, at);',
      'at = mix(at, eye + ray, down * down);',
      'float ease = smoothstep(uGroundHazeTop - 2.0 * uScaleHeight, uGroundHazeTop, rE);',
      'float haze = mix(share, 1.0, ease);',
      'vec3 look = normalize(mix(tangent, dir, down * down));',
      'vec3 glow = hazeGlow(column, grazing, at, uGroundHazeSun, look, eye);',
      'glow = mix(glow, hazeGlow(own, grazing, atOwn, uGroundHazeSun, dir, eye), ease / haze);',
      'cover = mix(share * min(2.0 * column / grazing, 1.0), ownCover, ease);',
      'return vec4(glow, haze);',
      'vec4 haze = groundHaze(vGroundHazeEye, vGroundHazeRay, cover);',
      'groundHazeLit.rgb = groundHazeLit.rgb * (1.0 - cover) + gl_FragColor.rgb * haze.a;',
    ]) {
      expect(frag).toContain(line)
    }
    // The shader squares.
    expect(GROUND_HAZE_POWER).toBe(2)
    clouds.dispose()
  })

  it("ports haze.glsl's columns as the shader has them", () => {
    for (const line of [
      'float z = mu * sqrt(0.5 * x);',
      'return exp(-(r - uSurface) / H) * H * sqrt(2.0 * x) / (z + sqrt(z * z + 1.2732395));',
      'float r = max(length(ro), uSurface);',
      'float hs = uSurface * uSurface - c2;',
      'line = grazing * exp(-(uSurface - p) / (1.5 * H));',
      'line = grazing * sqrt(p / uSurface) * exp(-(p - uSurface) / H);',
      'return max(line - hazeAbove(r, -mu), 0.0);',
      '#define HAZE_SEA_RAMP 0.1',
      'if (length(ro) < uSurface && length(ro) > uSeaLevel && bSea < 0.0 && hSea > 0.0) {',
      'vec3 eye = normalize(ro) * uSurface;',
      'float own = 1.0 - smoothstep(0.0, HAZE_SEA_RAMP, hSea / (bSea * bSea));',
      'column = mix(columnAhead(eye, normalize(sea - eye), grazing, atSea), column, own);',
    ]) {
      expect(hazeGlsl).toContain(line)
    }
  })

  it('hands over at the cloud shell\'s top, where the clouds ease to adding all the haze', () => {
    for (const flat of [false, true]) {
      const clouds = createCloudLayer(createEclipseShadow('earth'), flat)
      expect(groundHazeTop(flat)).toBe(clouds.shellAltitude)
      clouds.dispose()
    }
  })

  it('clears near ground, keeps the far sea horizon, and adds all the haze at the shell top', () => {
    const top = R + groundHazeTop(false)
    const stop = R + EARTH_GROUND_CLEARANCE
    // The sea s off from the stop, through the true air. A level ray's column
    // from the base is half the grazing line's.
    const fromStop = (s: number, share = 0.5) => {
      const eye = V(0, stop)
      return groundHazeWeights(stop, groundHazeDepth(eye, pointAt(stop, R, s).sub(eye), R), share, R, false)
    }
    for (const s of [0.005, 0.01]) {
      const near = fromStop(s)
      expect(near.cover).toBeLessThan(0.015)
      expect(near.haze).toBeLessThan(0.015)
    }
    expect(fromStop(0.02).haze).toBeLessThan(0.05)
    const horizon = Math.sqrt(stop * stop - R * R)
    const sea = fromStop(horizon)
    expect(sea.haze).toBeCloseTo(1 - Math.exp(-GROUND_HAZE_E), 6)
    expect(sea.cover).toBeCloseTo(sea.haze, 6)
    expect(sea.own).toBe(0)
    // Under a horizon whose column is faint (an eye standing high over the
    // point), little of the ground is hidden.
    expect(fromStop(horizon, 0.05).cover).toBeCloseTo(0.1 * sea.haze, 6)
    // Through the ease band the haze is at least the ease, and its colour
    // turns to the eye's own ray's.
    const band = top - 2 * R * ATMOSPHERE_SCALE_HEIGHT
    let last = 0
    for (let i = 1; i < 10; i++) {
      const eye = band + (top - band) * (i / 10)
      const w = groundHazeWeights(eye, 0.002, 0.5, R, false)
      const ease = THREE.MathUtils.smoothstep(eye, band, top)
      expect(w.haze).toBeGreaterThanOrEqual(ease)
      expect(w.own).toBeGreaterThan(last)
      expect(w.own).toBeLessThanOrEqual(1)
      last = w.own
    }
    expect(groundHazeWeights(band, 0.002, 0.5, R, false).own).toBe(0)
    // At the shell's top: none of the ground hidden, all of the haze added,
    // the atmosphere's own.
    for (const eye of [top, top - 1e-9]) {
      const w = groundHazeWeights(eye, 0.002, 0.5, R, false)
      expect(w.cover).toBeCloseTo(0, 6)
      expect(w.haze).toBeCloseTo(1, 6)
      expect(w.own).toBeCloseTo(1, 6)
    }
  })

  it("takes the segment's depth through the true air: the distance at the sea, thinner up, gathering at the horizon (tides-d9f.3)", () => {
    const air = R * GROUND_HAZE_AIR
    // Level along the sea: the distance.
    const sea = V(0, R)
    expect(groundHazeDepth(sea, pointAt(R, R, 0.01).sub(sea), R)).toBeCloseTo(0.01, 4)
    // Straight down from three of the air's heights: its thickness, to
    // Simpson's few samples.
    const eye = V(0, R + 3 * air)
    const down = groundHazeDepth(eye, V(0, -3 * air), R)
    const exact = air * (1 - Math.exp(-3))
    expect(down).toBeGreaterThan(0.9 * exact)
    expect(down).toBeLessThan(1.25 * exact)
    // From 20 km and 30 km up the sea well short of the horizon clears to
    // under a tenth (the base's density laid a quarter 100 km off), while the
    // horizon keeps all but a little of its haze, as the sky over it has.
    for (const km of [20, 30]) {
      const rE = R * (1 + km / EARTH_RADIUS_KM)
      const from = V(0, rE)
      const laid = (s: number) =>
        groundHazeWeights(rE, groundHazeDepth(from, pointAt(rE, R, s).sub(from), R), 0.5, R, false).haze
      expect(laid(R * (100 / EARTH_RADIUS_KM))).toBeLessThan(0.08)
      expect(laid(Math.sqrt(rE * rE - R * R))).toBeGreaterThan(0.95)
    }
  })

  it("meets the sky at the sea horizon: the sea's colour is the sky's just above it", () => {
    for (const g of [0.004, 0.02, 0.08]) {
      const eye = V(0, R + g)
      const tangentAngle = Math.acos(R / eye.y)
      const horizon = V(R * Math.sin(tangentAngle), R * Math.cos(tangentAngle))
      const tangent = horizon.clone().sub(eye).normalize()
      const above = tangent.clone().applyAxisAngle(V(0, 0, 1), 1e-6)
      const sky = columnAheadOverSea(eye, above)
      for (const f of [0.3, 0.9, 1]) {
        const a = f * tangentAngle
        const sea = V(R * Math.sin(a), R * Math.cos(a))
        const ref = reference(eye, sea.sub(eye))
        expect(ref.angleTo(tangent)).toBeLessThan(1e-6)
        expect(columnAhead(eye, ref) / GRAZING).toBeCloseTo(sky / GRAZING, 4)
      }
    }
  })

  // The haze's colour (its reference column) holds; its amount thins as the
  // eye rises through the true air (tides-d9f.3), with the segment.
  it("keeps a fixed ground point's haze colour as the eye bobs, where the eye's own ray's moved it", () => {
    const bob = EARTH_GROUND_CLEARANCE
    const oldLength = Math.sqrt(2 * R * EARTH_GROUND_CLEARANCE) / GROUND_HAZE_E
    let oldWorst = 0
    // Lowland and the Tibetan plateau (4.5 km, under the base and over it);
    // the far points on ridges standing over the plateau's horizon.
    for (const ground of [0.002, 0.0516]) {
      for (const [s, rise] of [
        [0.02, 0],
        [0.05, 0],
        [0.1, 0],
        [0.15, 0],
        [0.2, 0.01],
        [0.3, 0.02],
      ]) {
        const point = pointAt(R + ground + EARTH_GROUND_CLEARANCE, R + ground + rise, s)
        const laid = (y: number) => {
          const eye = V(0, R + ground + y)
          const ray = point.clone().sub(eye)
          const depth = groundHazeDepth(eye, ray, R)
          const w = groundHazeWeights(eye.y, depth, 0, R, false)
          const old = 1 - Math.exp(-ray.length() / oldLength)
          return {
            haze: w.haze,
            now: columnAhead(eye, reference(eye, ray)) / GRAZING,
            old: (old * columnAheadOverSea(eye, ray.normalize())) / GRAZING,
          }
        }
        const [a, b] = [laid(EARTH_GROUND_CLEARANCE), laid(EARTH_GROUND_CLEARANCE + bob)]
        expect(Math.abs(b.now - a.now)).toBeLessThan(0.08)
        // Over the plateau the higher eye is in the ease to its own ray's.
        if (ground < 0.01) expect(b.haze).toBeLessThanOrEqual(a.haze)
        oldWorst = Math.max(oldWorst, Math.abs(b.old - a.old))
      }
    }
    expect(oldWorst).toBeGreaterThan(0.08)
  })

  it("takes over from the atmosphere only for the ship's camera under the cloud shell's top", () => {
    const haze = createGroundHaze({ value: new THREE.Vector3(1, 0, 0) }, R, false)
    const shader = phongShader()
    haze.patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    const ground = new THREE.Mesh(new THREE.SphereGeometry(R))
    const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(R * ATMOSPHERE_OUTER))
    const material = new THREE.ShaderMaterial({ uniforms: { uOuter: { value: R * ATMOSPHERE_OUTER } } })
    const top = R + groundHazeTop(false)
    expect(top).toBeLessThan(R * ATMOSPHERE_OUTER)

    for (const [r, under] of [
      [R * 1.002, true],
      [top - 1e-6, true],
      [top + 1e-6, false],
      [R * (ATMOSPHERE_OUTER - 0.001), false],
      [R * (ATMOSPHERE_OUTER + 0.001), false],
      [R * 2, false],
    ] as const) {
      const camera = cameraAt(r)
      haze.update(ground, camera)
      expect(shader.uniforms.uGroundHaze.value).toBe(under ? 1 : 0)
      // The atmosphere stops at the ground exactly where the ground hazes
      // itself; elsewhere its back faces, if drawn, skip the depth test.
      pickShellFaces(atmosphere, material, camera, top)
      const reach = material.side === THREE.DoubleSide
      expect(reach).toBe(r < R * ATMOSPHERE_OUTER)
      expect(material.depthTest).toBe(!reach || under)
      pickShellFaces(atmosphere, material, camera)
      expect(material.depthTest).toBe(!reach)
    }

    const ortho = new THREE.OrthographicCamera()
    ortho.position.set(R * 1.002, 0, 0)
    ortho.updateMatrixWorld()
    haze.update(ground, ortho)
    expect(shader.uniforms.uGroundHaze.value).toBe(0)
  })

  it('lays the same haze on the surface tiles, on the same uniforms, their ray through the ground frame (tides-zmw.9.7)', () => {
    const haze = createGroundHaze({ value: new THREE.Vector3(1, 0, 0) }, R, false)
    const ground = phongShader()
    haze.patch.onBeforeCompile(ground, {} as THREE.WebGLRenderer)
    const tile = {
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.lambert.uniforms),
      vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
    } as THREE.WebGLProgramParametersWithUniforms
    haze.surfacePatch.onBeforeCompile(tile, {} as THREE.WebGLRenderer)
    for (const name of ['uGroundHaze', 'uGroundHazeSeaLevel', 'uGroundHazeLength', 'uGroundHazeTop', 'uGroundHazeSun']) {
      expect(tile.uniforms[name], name).toBe(ground.uniforms[name])
    }
    expect(tile.vertexShader).toContain('vGroundHazeRay = uGroundHazeViewToLocal * mvPosition.xyz;')
    expect(tile.vertexShader).toContain('vGroundHazeEye = uGroundHazeEyeLocal;')
    expect(ground.vertexShader).not.toContain('uGroundHazeViewToLocal')
    // The fragment is the ground's, word for word.
    const body = (f: string) => f.slice(f.indexOf('uniform float uGroundHaze;'), f.indexOf('#undef uDusk'))
    expect(body(tile.fragmentShader)).toBe(body(ground.fragmentShader))
    expect(tile.fragmentShader).toContain('vec4 haze = groundHaze(vGroundHazeEye, vGroundHazeRay, cover);')
    expect(haze.surfacePatch.customProgramCacheKey()).not.toBe(haze.patch.customProgramCacheKey())

    // update() fills the frame for this camera: a tile point's ray and eye
    // in the ground frame match what the ground's own vertex stage forms.
    const earth = new THREE.Group()
    earth.position.set(5000, -300, 1200)
    earth.rotation.set(0.3, 1.1, -0.4)
    const groundMesh = new THREE.Mesh(new THREE.SphereGeometry(R))
    earth.add(groundMesh)
    earth.updateMatrixWorld(true)
    const camera = new THREE.PerspectiveCamera()
    const local = new THREE.Vector3(R + 0.01, 0.02, -0.03)
    camera.position.copy(local).applyMatrix4(groundMesh.matrixWorld)
    camera.lookAt(new THREE.Vector3(0, 0, 0).applyMatrix4(groundMesh.matrixWorld))
    camera.updateMatrixWorld(true)
    haze.update(groundMesh, camera)
    const eye = tile.uniforms.uGroundHazeEyeLocal.value as THREE.Vector3
    expect(eye.distanceTo(local)).toBeLessThan(1e-9)
    const point = new THREE.Vector3(R, 0.05, 0.01)
    const view = point.clone().applyMatrix4(groundMesh.matrixWorld).applyMatrix4(camera.matrixWorldInverse.copy(camera.matrixWorld).invert())
    const ray = view.applyMatrix3(tile.uniforms.uGroundHazeViewToLocal.value as THREE.Matrix3)
    expect(ray.distanceTo(point.clone().sub(local))).toBeLessThan(1e-9)
  })
})
