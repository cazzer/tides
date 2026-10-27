import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { activeRegions } from './sun-activity'
import { surfaceBakeUniforms } from './sun-surface'
import * as THREE from 'three'
import { COLLISION_MARGIN } from '../ship/flight'
import { NEAR_SHARE } from '../ship/ship-session'
import {
  cellEdgeDistance,
  EDGE_BAND,
  eyeInObject,
  SPICULE_FADE_PX,
  SPICULE_WIDTH,
  spiculeArrays,
  spiculeInstanceCount,
  SPICULE_BUDGET,
  SPICULE_MAX_BLADES,
  SPICULE_MAX_LEAN,
  spiculeTufts,
  SUN_FRINGE,
  SUN_SEGMENTS,
  SUN_SHELL,
  sunShellScale,
  TUFT_RADIUS,
} from './sun-spicules'
import {
  createProminenceGeometry,
  PROMINENCE_BUDGET,
  PROMINENCE_KIND,
  PROMINENCE_TOP,
  strandPoints,
} from './sun-prominences'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const DEG = 180 / Math.PI

describe('the Sun\'s activity layout', () => {
  it('is the same on every call, so scrubbing the date shows the same Sun', () => {
    expect(activeRegions()).toEqual(activeRegions())
  })

  it('keeps every spot group in the activity belts', () => {
    for (const region of activeRegions()) {
      const lat = Math.abs(region.lat * DEG)
      expect(lat).toBeGreaterThanOrEqual(5)
      expect(lat).toBeLessThanOrEqual(35)
      for (const spot of region.spots) {
        expect(Math.hypot(...spot.dir)).toBeCloseTo(1, 9)
        expect(Math.abs(Math.asin(spot.dir[1]) * DEG)).toBeLessThan(40)
      }
    }
  })

  it('gives the bake each region\'s two poles, for its loops to join', () => {
    const regions = activeRegions()
    const uniforms = surfaceBakeUniforms()
    expect(uniforms.regionCount).toBe(regions.length)
    expect(uniforms.uLead.value).toHaveLength(regions.length)
    expect(uniforms.uFollow.value).toHaveLength(regions.length)
    regions.forEach((r, i) => {
      expect(uniforms.uLead.value[i].toArray().slice(0, 3)).toEqual(r.spots[0].dir)
      expect(uniforms.uFollow.value[i].w).toBe(r.span)
    })
  })
})

describe('the photosphere', () => {
  const renderer = read('./SunRenderer.tsx')
  const fragment = read('../shaders/sun/fragment.frag')

  it('no longer renders a cube map every frame (tides-d9x)', () => {
    expect(renderer).not.toMatch(/CubeCamera/)
    expect(renderer).not.toMatch(/frames=\{Infinity\}/)
  })

  it('costs three texture lookups, and noise only in the limb\'s fringe', () => {
    expect(fragment.match(/textureCube\(/g)).toHaveLength(3)
    expect(fragment).not.toMatch(/worley/)
    const start = fragment.indexOf('if (miss > 0.999')
    const end = fragment.indexOf('\n  }\n', start)
    expect(start).toBeGreaterThan(0)
    const branch = fragment.slice(start, end)
    const outside = fragment.slice(0, start) + fragment.slice(end)
    expect(branch).toMatch(/snoise3/)
    expect(outside).not.toMatch(/snoise/)
  })

  it('writes the traced sphere\'s depth, and coverage for its edge', () => {
    expect(fragment).toMatch(/#ifdef SUN_TRACED_DEPTH\n {2}float depth = fragDepthOfClip\(projectionMatrix \* modelViewMatrix \* vec4\(hit, 1\.0\)\);/)
    expect(fragment).toMatch(/gl_FragDepth = depth;\n#endif/)
    // Not before the lookups, whose mip level needs their neighbours.
    expect(fragment.indexOf('discard')).toBeGreaterThan(fragment.lastIndexOf('textureCube('))
    expect(fragment).toMatch(/gl_FragColor = vec4\(gold\(I\), solid\)/)
    expect(fragment).toMatch(/if \(solid <= 0\.0\) discard;/)
    expect(renderer).toMatch(/alphaToCoverage: true/)
  })

  it('takes no settings from the URL', () => {
    expect(renderer).not.toMatch(/URLSearchParams/)
    expect(read('./SunProminences.tsx')).not.toMatch(/URLSearchParams/)
    expect(read('../shaders/sun-prominence/fragment.frag')).not.toMatch(/uProto/)
  })

  it('draws a shell that holds the tallest jets, inside the ship\'s stop and its near plane', () => {
    expect(SUN_FRINGE).toBeGreaterThanOrEqual(0.005)
    expect(SUN_FRINGE).toBeLessThanOrEqual(0.02)
    const [width, height] = SUN_SEGMENTS
    const halfDiagonal = 0.5 * Math.hypot((2 * Math.PI) / width, Math.PI / height)
    // A facet's plane sits no deeper than this under the sphere.
    expect(SUN_SHELL * Math.cos(halfDiagonal)).toBeGreaterThanOrEqual(1 + SUN_FRINGE)
    expect(SUN_SHELL * Math.cos(Math.PI / Math.min(width, height))).toBeGreaterThanOrEqual(1 + SUN_FRINGE)
    expect(SUN_SHELL).toBe(sunShellScale(SUN_SEGMENTS))
    // At the stop the near plane stands NEAR_SHARE of the gap to the ground
    // off the eye: the shell must lie beyond it, or it cuts a hole.
    expect(COLLISION_MARGIN - SUN_SHELL).toBeGreaterThan(NEAR_SHARE * (COLLISION_MARGIN - 1))
    // A plain sphere: the trace makes the limb exact.
    expect(renderer).not.toMatch(/useBodySphere/)
  })

  it('bakes its churn with the rest, not per frame', () => {
    expect(read('./sun-surface.ts')).toMatch(/plasmaBakeFragment/)
    expect(renderer).toMatch(/uPlasma: \{ value: surface\.plasma \}/)
  })
})

describe('the corona', () => {
  const fragment = read('../shaders/sun-corona/fragment.frag')

  it('reads its streamers from the baked pattern, once, with no noise per pixel', () => {
    expect(fragment.match(/textureCube\(/g)).toHaveLength(1)
    expect(fragment).not.toMatch(/snoise|noise3/)
  })

  it('reads the pattern in the Sun\'s frame, not the screen\'s', () => {
    expect(fragment).toContain('normalize(vSolarPlane / max(r, 1e-4) + vSolarLimb)')
  })
})

describe('the prominences and loops', () => {
  it('fit their per-tier budgets, the phone tier well under the desktop one', () => {
    const high = createProminenceGeometry(false)
    const low = createProminenceGeometry(true)
    const highVerts = high.getAttribute('position').count
    const lowVerts = low.getAttribute('position').count
    expect(lowVerts).toBeLessThan(highVerts / 2)
    // Two vertices per spine sample.
    expect(lowVerts % ((PROMINENCE_BUDGET.low.segments + 1) * 2)).toBe(0)
    expect(highVerts).toBeLessThan(20000)
    for (const name of ['aTangent', 'aStrand', 'aKind']) {
      expect(high.getAttribute(name).count).toBe(highVerts)
    }
    high.dispose()
    low.dispose()
  })

  it('stand on the surface and stay under PROMINENCE_TOP', () => {
    for (const low of [false, true]) {
      for (const { points } of strandPoints(low)) {
        const radii = points.map((p) => Math.hypot(...p))
        // Feet sink just under the limb, where the Sun hides them.
        expect(radii[0]).toBeLessThan(1)
        expect(radii[0]).toBeGreaterThan(0.98)
        for (const r of radii) expect(r).toBeLessThan(PROMINENCE_TOP)
      }
    }
  })

  it('include arches, hedgerows and loops, and are deterministic', () => {
    const kinds = new Set(strandPoints(false).map((s) => s.kind))
    expect(kinds).toEqual(new Set(Object.values(PROMINENCE_KIND)))
    expect(strandPoints(true)).toEqual(strandPoints(true))
  })

  it('test the Sun along the ray, as the depth test can tie at ship range', () => {
    const fragment = read('../shaders/sun-prominence/fragment.frag')
    expect(fragment).toMatch(/if \(b > 0\.0 && across > 0\.99\) discard;/)
  })
})

describe('the spicule tufts', () => {
  const tufts = spiculeTufts()
  const blades = tufts.flatMap((t) => t.blades)
  type V = [number, number, number]
  const unit = (v: V): V => {
    const l = Math.hypot(...v)
    return [v[0] / l, v[1] / l, v[2] / l]
  }
  const dist = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

  it('are laid out the same on every build', () => {
    const a = spiculeArrays()
    const b = spiculeArrays()
    expect(a.count).toBe(blades.length)
    expect(b.count).toBe(a.count)
    // Checksums: comparing ~1M floats one by one is slow.
    const sum = (array: Float32Array) => array.reduce((total, v, i) => total + v * ((i % 7) + 1), 0)
    for (const name of ['spicule', 'lean', 'size'] as const) {
      expect(a[name]).not.toBe(b[name])
      expect(sum(a[name])).toBe(sum(b[name]))
    }
  })

  it('stand on the network\'s lanes', () => {
    expect(tufts).toHaveLength(SPICULE_BUDGET.high.tufts)
    for (const tuft of tufts) expect(cellEdgeDistance(tuft.axis)).toBeLessThan(EDGE_BAND)
  })

  it('keep their blades round them, rooted under the limb and short of the fringe\'s reach', () => {
    const [fewest, most] = SPICULE_BUDGET.high.blades
    for (const tuft of tufts) {
      expect(tuft.blades.length).toBeGreaterThanOrEqual(fewest)
      expect(tuft.blades.length).toBeLessThanOrEqual(most)
      for (const b of tuft.blades) {
        const up = unit(b.foot)
        expect(dist(up, tuft.axis)).toBeLessThanOrEqual(TUFT_RADIUS)
        expect(Math.hypot(...b.foot)).toBeLessThan(1)
        const lean = Math.hypot(...b.lean)
        expect(lean).toBeLessThanOrEqual(SPICULE_MAX_LEAN + 1e-9)
        // The lean is tangent at the foot.
        expect(Math.abs(b.lean[0] * up[0] + b.lean[1] * up[1] + b.lean[2] * up[2])).toBeLessThan(1e-9)
        const axis = unit([up[0] + b.lean[0], up[1] + b.lean[1], up[2] + b.lean[2]])
        const top: V = [b.foot[0] + axis[0] * b.height, b.foot[1] + axis[1] * b.height, b.foot[2] + axis[2] * b.height]
        expect(Math.hypot(...top)).toBeLessThan(1 + 2 * SUN_FRINGE)
      }
    }
  })

  it('fit the budget', () => {
    expect(blades.length).toBeLessThanOrEqual(SPICULE_MAX_BLADES)
    expect(blades.length).toBeLessThanOrEqual(120000)
  })

  it('clump into bushes, not an even fur', () => {
    // Nearest neighbours by a lattice of buckets, ~0.05 R wide.
    const key = (v: V) => v.map((x) => Math.floor(x * 20)).join(',')
    const buckets = new Map<string, V[]>()
    for (const t of tufts) buckets.set(key(t.axis), [...(buckets.get(key(t.axis)) ?? []), t.axis])
    let spacing = 0
    for (const t of tufts) {
      const [x, y, z] = t.axis.map((v) => Math.floor(v * 20))
      let nearest = Infinity
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++)
            for (const other of buckets.get([x + dx, y + dy, z + dz].join(',')) ?? [])
              if (other !== t.axis) nearest = Math.min(nearest, dist(other, t.axis))
      spacing += nearest / tufts.length
    }
    let spread = 0
    for (const t of tufts) for (const b of t.blades) spread += dist(unit(b.foot), t.axis) / blades.length
    expect(spread).toBeLessThan(0.2 * spacing)
  })
})

describe('the Sun\'s per-view set-up', () => {
  // A Sun of radius 10 under a parent turned and squashed (as View from
  // Earth squashes it), 40 units from the camera.
  function scene(camera: THREE.Camera) {
    const parent = new THREE.Group()
    parent.rotation.set(0.4, -1.1, 0.3)
    parent.scale.set(1, 0.6, 1)
    parent.position.set(3, -2, -40)
    const mesh = new THREE.Mesh()
    mesh.scale.setScalar(10)
    parent.add(mesh)
    parent.updateMatrixWorld(true)
    camera.updateMatrixWorld(true)
    return mesh
  }

  it('finds the eye and the view direction in the Sun\'s own frame', () => {
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000)
    camera.position.set(1, 2, 5)
    camera.lookAt(3, -2, -40)
    const mesh = scene(camera)
    const eye = new THREE.Vector3()
    const dir = new THREE.Vector3()
    eyeInObject(camera, mesh, eye, dir)
    // Back out to the world, the eye is the camera.
    expect(eye.clone().applyMatrix4(mesh.matrixWorld).distanceTo(camera.position)).toBeLessThan(1e-9)
    expect(dir.length()).toBeCloseTo(1, 12)
    // And the direction, carried back, is the camera's forward.
    const forward = camera.getWorldDirection(new THREE.Vector3())
    const back = dir.clone().transformDirection(mesh.matrixWorld)
    expect(back.dot(forward)).toBeCloseTo(1, 9)
  })

  const BLADES = 1000
  const viewHeight = 800

  it('draws every blade close in, none far out', () => {
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.001, 1e5)
    const mesh = scene(camera)
    const centre = mesh.getWorldPosition(new THREE.Vector3())
    const R = mesh.matrixWorld.getMaxScaleOnAxis()
    const from = (distance: number) => {
      camera.position.copy(centre).add(new THREE.Vector3(0, 0, distance))
      camera.lookAt(centre)
      camera.updateMatrixWorld(true)
      return spiculeInstanceCount(camera, mesh, viewHeight, BLADES)
    }
    // The widest blade's px at the nearest surface point.
    const px = (distance: number) =>
      (SPICULE_WIDTH[1] * R * camera.projectionMatrix.elements[5] * 0.5 * viewHeight) / (distance - R)
    expect(px(R * 1.02)).toBeGreaterThan(SPICULE_FADE_PX[0])
    expect(from(R * 1.02)).toBe(BLADES)
    expect(px(R * 10)).toBeLessThan(SPICULE_FADE_PX[0])
    expect(from(R * 10)).toBe(0)
  })

  it('sizes them by zoom alone in an orthographic view', () => {
    const camera = new THREE.OrthographicCamera(-200, 200, 125, -125, 0.1, 1000)
    const mesh = scene(camera)
    expect(spiculeInstanceCount(camera, mesh, viewHeight, BLADES)).toBe(0)
    camera.zoom = 200
    camera.updateProjectionMatrix()
    expect(spiculeInstanceCount(camera, mesh, viewHeight, BLADES)).toBe(BLADES)
  })
})
