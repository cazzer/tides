import * as THREE from 'three'
import { MakeTime, RotateVector, Rotation_EQJ_ECT, Vector } from 'astronomy-engine'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { eclipticToScene } from '../ephemeris'
import { orientStarfield } from './Starfield'

// Counts the precession/nutation rotations orientStarfield asks for, passing
// through to the real one.
const calls = vi.hoisted(() => ({ rotation: 0 }))
vi.mock('astronomy-engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('astronomy-engine')>()
  return {
    ...real,
    Rotation_EQJ_ECT: (time: Parameters<typeof real.Rotation_EQJ_ECT>[0]) => {
      calls.rotation += 1
      return real.Rotation_EQJ_ECT(time)
    },
  }
})

// The unmemoized orientation, as orientStarfield computed it before the cache.
function reference(t: number): THREE.Quaternion {
  const time = MakeTime(new Date(t))
  const rotation = Rotation_EQJ_ECT(time)
  const images = [0, 1, 2].map((axis) =>
    eclipticToScene(
      RotateVector(rotation, new Vector(+(axis === 0), +(axis === 1), +(axis === 2), time)),
      new THREE.Vector3()
    )
  )
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(images[0], images[1], images[2])
  )
}

// Minutes apart: astronomy-engine reuses its nutation for times within ~86 ms
// of the last one it computed.
const T1 = Date.UTC(2026, 2, 20, 15)
const T2 = Date.UTC(1990, 0, 1)
const MINUTE = 60_000

describe('orientStarfield memo', () => {
  beforeEach(() => {
    calls.rotation = 0
  })

  test('the stars, lines and art at one instant share one computation, bit for bit', () => {
    const t = T1 + MINUTE
    const objects = [new THREE.Object3D(), new THREE.Object3D(), new THREE.Object3D()]
    for (const o of objects) orientStarfield(o, t)
    expect(calls.rotation).toBe(1)
    const want = reference(t).toArray()
    for (const o of objects) expect(o.quaternion.toArray()).toEqual(want)
  })

  test('a different instant recomputes, and going back gives the first orientation again', () => {
    const a = new THREE.Object3D(), b = new THREE.Object3D(), c = new THREE.Object3D()
    orientStarfield(a, T1)
    orientStarfield(b, T2)
    orientStarfield(c, T1)
    expect(calls.rotation).toBe(3)
    expect(b.quaternion.toArray()).toEqual(reference(T2).toArray())
    expect(b.quaternion.equals(a.quaternion)).toBe(false)
    expect(c.quaternion.toArray()).toEqual(a.quaternion.toArray())
  })

  test('each object keeps its own quaternion', () => {
    const t = T2 + MINUTE
    const a = new THREE.Object3D(), b = new THREE.Object3D()
    orientStarfield(a, t)
    a.quaternion.identity()
    orientStarfield(b, t)
    expect(b.quaternion.toArray()).toEqual(reference(t).toArray())
    expect(a.quaternion.toArray()).toEqual([0, 0, 0, 1])
  })
})
