import { describe, expect, it } from 'vitest'
import { OrthographicCamera, Quaternion, Vector3 } from 'three'
import { OrbitControls } from 'three-stdlib'
import {
  MAX_TILT,
  MIN_PIVOT_DEPTH,
  applyTilt,
  canPivot,
  clampTilt,
  headingUp,
  pivotDepth,
  pixelsToPivot,
  settlePivot,
  tiltControls,
  wrapAngle,
  type Pivot,
} from './pivot'

describe('pixelsToPivot', () => {
  it('turns half a turn per view height', () => {
    expect(pixelsToPivot(0, -800, 800).tilt).toBeCloseTo(Math.PI)
    expect(pixelsToPivot(-800, 0, 800).heading).toBeCloseTo(Math.PI)
  })

  it('tilts toward the horizon when moving up', () => {
    expect(pixelsToPivot(0, -10, 800).tilt).toBeGreaterThan(0)
  })
})

describe('clampTilt and wrapAngle', () => {
  it('keeps tilt between straight down and 80°', () => {
    expect(clampTilt(-0.1)).toBe(0)
    expect(clampTilt(2)).toBe(MAX_TILT)
    expect(MAX_TILT).toBeCloseTo((80 * Math.PI) / 180)
    expect(clampTilt(0.5)).toBe(0.5)
  })

  it('wraps heading into a single turn', () => {
    expect(wrapAngle(3 * Math.PI + 0.25)).toBeCloseTo(-Math.PI + 0.25)
    expect(wrapAngle(-0.25)).toBeCloseTo(-0.25)
  })
})

describe('pivotDepth', () => {
  it('pivots about the centre far out and the surface up close', () => {
    expect(pivotDepth(1)).toBe(0)
    expect(pivotDepth(0)).toBe(1)
    expect(pivotDepth(0.5)).toBeCloseTo(0.75)
  })
})

describe('settlePivot', () => {
  const tilted = (): Pivot => ({ tilt: 0.9, heading: -2.5, depth: 0.95 })
  /** Frames until tilt and heading are both back to zero. */
  const settle = (pivot: Pivot, depth: () => number | null) => {
    let frames = 0
    while ((pivot.tilt !== 0 || pivot.heading !== 0) && frames < 1000) {
      settlePivot(pivot, depth())
      frames++
    }
    return frames
  }

  it('keeps the tilt and heading while zoomed in on Earth', () => {
    const pivot = tilted()
    for (let i = 0; i < 300; i++) settlePivot(pivot, 0.9)
    expect(pivot).toEqual({ ...tilted(), depth: 0.9 })
    settlePivot(pivot, MIN_PIVOT_DEPTH)
    expect(pivot.tilt).toBe(0.9)
  })

  it('eases them back to zero once zoomed out, without a jump', () => {
    const pivot = tilted()
    let { tilt, heading } = pivot
    const frames = settle(pivot, () => {
      // No frame moves more than the ease's share of what is left, bar the
      // final imperceptible snap to zero.
      expect(tilt - pivot.tilt).toBeLessThanOrEqual(0.05 * tilt + 1e-4)
      expect(Math.abs(heading - pivot.heading)).toBeLessThanOrEqual(
        0.05 * Math.abs(heading) + 1e-4
      )
      ;({ tilt, heading } = pivot)
      return 0
    })
    expect(frames).toBeGreaterThan(60)
    expect(frames).toBeLessThan(300)
    expect(pivot).toEqual({ tilt: 0, heading: 0, depth: 0 })
  })

  it('stops easing when zooming back in, keeping what is left', () => {
    const pivot = tilted()
    for (let i = 0; i < 20; i++) settlePivot(pivot, 0.3)
    const { tilt, heading } = pivot
    expect(tilt).toBeLessThan(0.9)
    expect(tilt).toBeGreaterThan(0)
    for (let i = 0; i < 20; i++) settlePivot(pivot, 0.8)
    expect(pivot).toEqual({ tilt, heading, depth: 0.8 })
  })

  it('eases all three back outside Earth focus', () => {
    const pivot = tilted()
    settle(pivot, () => null)
    for (let i = 0; i < 300; i++) settlePivot(pivot, null)
    expect(pivot).toEqual({ tilt: 0, heading: 0, depth: 0 })
  })

  it('takes pivot input only while zoomed in', () => {
    expect(canPivot({ tilt: 0, heading: 0, depth: 0.9 })).toBe(true)
    expect(canPivot({ tilt: 0, heading: 0, depth: MIN_PIVOT_DEPTH })).toBe(true)
    expect(canPivot({ tilt: 0, heading: 0, depth: 0.2 })).toBe(false)
  })
})

/** A camera at `position` looking at the origin with north up. */
function cameraAt(position: Vector3, up = new Vector3(0, 1, 0)) {
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1000)
  camera.position.copy(position)
  camera.up.copy(up)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  return camera
}

describe('headingUp', () => {
  const normal = new Vector3(1, 0.5, 0.3).normalize()
  const position = normal.clone().multiplyScalar(80)
  const radius = 3

  it('is north at zero heading', () => {
    expect(headingUp(new Vector3(), normal, 0)).toEqual(new Vector3(0, 1, 0))
  })

  it('turns the ground below the centre with the fingers', () => {
    const ground = normal.clone().multiplyScalar(radius)
    const below = cameraAt(position).localToWorld(new Vector3(0, -0.1, 0))
    below.sub(position).add(ground)
    const before = below.clone().project(cameraAt(position))
    const { heading } = pixelsToPivot(10, 0, 800)
    const up = headingUp(new Vector3(), normal, heading)
    const after = below.clone().project(cameraAt(position, up))
    expect(after.x).toBeGreaterThan(before.x)
  })

  it('keeps the angle to the local vertical', () => {
    const up = headingUp(new Vector3(), normal, 1.2)
    expect(up.dot(normal)).toBeCloseTo(normal.y)
  })
})

describe('applyTilt', () => {
  const centre = new Vector3(10, -2, 4)
  const normal = new Vector3(0.3, 0.8, -0.5).normalize()
  const radius = 3
  const setup = (distance = 80) => {
    const camera = cameraAt(normal.clone().multiplyScalar(distance))
    camera.position.add(centre)
    return {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
    }
  }
  const viewDirection = (quaternion: Quaternion) =>
    new Vector3(0, 0, -1).applyQuaternion(quaternion)

  it('leaves the camera alone at zero tilt', () => {
    const { position, quaternion } = setup()
    const p = position.clone()
    const q = quaternion.clone()
    applyTilt(p, q, centre, radius, 1, 0)
    expect(p).toEqual(position)
    expect(q).toEqual(quaternion)
  })

  it.each([0, 0.5, 1])(
    'keeps the pivot at screen centre and tilts the view (depth %s)',
    (depth) => {
      const tilt = 0.7
      const { position, quaternion } = setup()
      applyTilt(position, quaternion, centre, radius, depth, tilt)
      const pivot = centre.clone().addScaledVector(normal, radius * depth)
      const toPivot = pivot.sub(position).normalize()
      expect(toPivot.dot(viewDirection(quaternion))).toBeCloseTo(1, 10)
      expect(viewDirection(quaternion).negate().angleTo(normal)).toBeCloseTo(
        tilt,
        10
      )
    }
  )

  it('lifts the horizon from the top of the screen', () => {
    const { position, quaternion } = setup()
    const screenUp = new Vector3(0, 1, 0).applyQuaternion(quaternion)
    applyTilt(position, quaternion, centre, radius, 1, 0.5)
    expect(viewDirection(quaternion).dot(screenUp)).toBeGreaterThan(0)
  })

  it('keeps the camera outside Earth at the closest distance', () => {
    for (const depth of [0, 0.5, 1]) {
      const { position, quaternion } = setup(5)
      applyTilt(position, quaternion, centre, radius, depth, MAX_TILT)
      expect(position.distanceTo(centre)).toBeGreaterThan(radius)
    }
  })
})

describe('tiltControls', () => {
  const radius = 3
  const setup = (pivot: Pivot, start = new Vector3(30, 40, 50)) => {
    const camera = new OrthographicCamera()
    camera.position.copy(start)
    const controls = new OrbitControls(camera)
    const original = controls.update
    const undo = tiltControls(controls, camera, pivot, () => radius)
    return { camera, controls, original, undo }
  }
  const pose = (camera: OrthographicCamera) => ({
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
  })

  it("doesn't drift over repeated updates", () => {
    const { camera, controls } = setup({ tilt: 0.6, heading: 0.8, depth: 1 })
    controls.update()
    const first = pose(camera)
    for (let i = 0; i < 1200; i++) controls.update()
    expect(camera.position.distanceTo(first.position)).toBeLessThan(1e-9)
    expect(Math.abs(camera.quaternion.dot(first.quaternion))).toBeCloseTo(1, 12)
  })

  it('shows the same tilt and heading on top of the untilted orbit', () => {
    const pivot = { tilt: 0.6, heading: 0.8, depth: 1 }
    const { camera, controls } = setup(pivot)
    controls.update()
    const flat = setup({ ...pivot, tilt: 0 })
    flat.controls.update()
    const expected = pose(flat.camera)
    applyTilt(
      expected.position,
      expected.quaternion,
      new Vector3(),
      radius,
      1,
      0.6
    )
    expect(camera.position.distanceTo(expected.position)).toBeLessThan(1e-9)
    expect(Math.abs(camera.quaternion.dot(expected.quaternion))).toBeCloseTo(
      1,
      12
    )
  })

  it('matches an untilted session once the pivot has settled', () => {
    const pivot = { tilt: 0.6, heading: 0.8, depth: 1 }
    const { camera, controls } = setup(pivot)
    controls.update()
    for (let i = 0; i < 300; i++) {
      settlePivot(pivot, 0)
      controls.update()
    }
    const flat = setup({ tilt: 0, heading: 0, depth: 0 })
    flat.controls.update()
    expect(camera.position.distanceTo(flat.camera.position)).toBeLessThan(1e-9)
    expect(Math.abs(camera.quaternion.dot(flat.camera.quaternion))).toBeCloseTo(
      1,
      12
    )
    expect(camera.up).toEqual(new Vector3(0, 1, 0))
  })

  it('takes an outside move as the new untilted pose', () => {
    const pivot = { tilt: 0.6, heading: 0.8, depth: 1 }
    const { camera, controls } = setup(pivot)
    controls.update()
    camera.position.set(0, 0, 50)
    controls.update()
    const fresh = setup(pivot, new Vector3(0, 0, 50))
    fresh.controls.update()
    expect(camera.position.distanceTo(fresh.camera.position)).toBeLessThan(1e-9)
  })

  it('reports a tilt-only change', () => {
    const pivot = { tilt: 0, heading: 0, depth: 1 }
    const { controls } = setup(pivot)
    controls.update()
    controls.update()
    let changes = 0
    controls.addEventListener('change', () => changes++)
    controls.update()
    expect(changes).toBe(0)
    pivot.tilt = 0.3
    controls.update()
    expect(changes).toBe(1)
  })

  it('undoes the wrap, the tilt and the heading', () => {
    const pivot = { tilt: 0.6, heading: 0.8, depth: 1 }
    const { camera, controls, original, undo } = setup(pivot)
    controls.update()
    const flat = setup({ ...pivot, tilt: 0 })
    flat.controls.update()
    undo()
    expect(controls.update).toBe(original)
    expect(camera.position.distanceTo(flat.camera.position)).toBeLessThan(1e-9)
    expect(camera.up).toEqual(new Vector3(0, 1, 0))
  })
})
