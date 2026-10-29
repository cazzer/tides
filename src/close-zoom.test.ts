import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Object3D, PerspectiveCamera, Vector3 } from 'three'
import { OrbitControls } from 'three-stdlib'
import {
  CLOSE_ZOOM_HYSTERESIS,
  closeZoomClearance,
  closeZoomFloor,
  closeZoomSpeed,
  earthGroundRadius,
  isCloseZoom,
} from './close-zoom'
import { MIN_DISTANCE_FACTOR, NEAR_MIN, mainNearFar } from './main-view'
import { EARTH_KM_PER_UNIT, surfaceOpacityUniform } from './surface-handover'
import { EARTH_RADIUS_KM } from './cloud-layer'
import { setSurfaceGroundSampler, type SurfaceGroundQuery } from './surface-ground'
import { RELIEF } from './relief'
import { EARTH_UNITS_PER_METRE, SURFACE_GROUND_MARGIN_METRES } from './ship/ship-bodies'
import { NEAR_MIN as SHIP_NEAR_MIN, NEAR_MIN_REVERSED } from './ship/ship-session'
import {
  EARTH_BASE_SEGMENTS,
  buildTerrainFloor,
  meanGrey,
  setEarthTerrain,
  terrainFloorRadius,
} from './ship/terrain-floor'
import { decodeEarthDem } from './earth-dem'
import { LIMB_SEGMENTS, disposeLimbSpheres, limbSphere, retainLimbSphere } from './ship/limb-detail'
import { calculateLocationAndRotationForLatLng } from './utils'
import { useStore } from './store'

const R = 3
const BARRIER = MIN_DISTANCE_FACTOR * R

describe('isCloseZoom', () => {
  it('enters below the barrier and leaves only past its hysteresis', () => {
    expect(isCloseZoom(BARRIER * 1.001, R, false)).toBe(false)
    expect(isCloseZoom(BARRIER, R, false)).toBe(false)
    expect(isCloseZoom(BARRIER * 0.999, R, false)).toBe(true)
    // Backing out just past the barrier stays close…
    expect(isCloseZoom(BARRIER * (1 + CLOSE_ZOOM_HYSTERESIS / 2), R, true)).toBe(true)
    // …until past the hysteresis.
    expect(isCloseZoom(BARRIER * (1 + 2 * CLOSE_ZOOM_HYSTERESIS), R, true)).toBe(false)
  })
})

describe('closeZoomClearance', () => {
  it('is a kilometre on a reversed float depth buffer, else twice the ship near floor', () => {
    expect(closeZoomClearance(true) * EARTH_KM_PER_UNIT).toBeCloseTo(1, 9)
    expect(closeZoomClearance(false)).toBe(2 * SHIP_NEAR_MIN)
  })
})

describe('closeZoomFloor', () => {
  const c = 0.001
  it('stands the clearance over the higher ground, looking straight down', () => {
    expect(closeZoomFloor(R, R, c, 0)).toBeCloseTo(R + c, 12)
    expect(closeZoomFloor(R, R + 0.002, c, 0)).toBeCloseTo(R + 0.003, 12)
    // Lower ground under the eye than under the target doesn't lower it.
    expect(closeZoomFloor(R + 0.002, R, c, 0)).toBeCloseTo(R + 0.002 + c, 12)
  })

  it('keeps the tilted eye clear: at 80° the eye stands back ~5.8 times as far', () => {
    const tilt = (80 * Math.PI) / 180
    const floor = closeZoomFloor(R, R + 0.002, c, tilt)
    expect(floor).toBeCloseTo(R + 0.003 / Math.cos(tilt), 12)
    // The tipped eye's height over the pivot clears the eye's ground.
    expect((floor - R) * Math.cos(tilt)).toBeCloseTo(0.002 + c, 12)
  })
})

describe('closeZoomSpeed', () => {
  const RE = EARTH_RADIUS_KM / EARTH_KM_PER_UNIT
  const km = 1 / EARTH_KM_PER_UNIT
  const floor = RE + km
  const EARTH_BARRIER = MIN_DISTANCE_FACTOR * RE
  const notch = (d: number) => d * 0.95 ** closeZoomSpeed(d, floor)
  /** Wheel notches from `d` until the eye rests on the floor, each clamped to it as OrbitControls does. */
  const notchesToFloor = (from: number) => {
    let d = from
    let n = 0
    while (d !== floor && n < 100) {
      const next = Math.max(notch(d), floor)
      expect(next).toBeLessThan(d)
      d = next
      n++
    }
    expect(d).toBe(floor)
    return n
  }

  it('is a whole step at the barrier and above', () => {
    expect(closeZoomSpeed(EARTH_BARRIER, floor)).toBe(1)
    expect(closeZoomSpeed(2 * EARTH_BARRIER, floor)).toBe(1)
  })

  it('falls continuously from the barrier to the floor, and so does the step', () => {
    let previous = closeZoomSpeed(EARTH_BARRIER, floor)
    let previousStep = EARTH_BARRIER - notch(EARTH_BARRIER)
    for (
      let d = floor + (EARTH_BARRIER - floor) * 0.9;
      d > floor + 1e-3 * km;
      d = floor + (d - floor) * 0.9
    ) {
      const speed = closeZoomSpeed(d, floor)
      expect(speed).toBeLessThanOrEqual(previous)
      // The ease steepens the fall near 30 km: at most ~12.4% a step of 0.9.
      expect(previous - speed).toBeLessThan(0.13 * previous)
      const step = d - notch(d)
      expect(step).toBeLessThan(previousStep)
      previous = speed
      previousStep = step
    }
  })

  it('moves about a fifth of the altitude a notch far out, as before', () => {
    for (const altitude of [1000, 300]) {
      const d = RE + altitude * km
      const cut = (d - notch(d)) / (altitude * km)
      expect(cut).toBeGreaterThan(0.19)
      expect(cut).toBeLessThan(0.21)
    }
  })

  it('eases to 8% of the way left plus a kilometre near the ground', () => {
    const share = (altitude: number) => {
      const d = RE + altitude * km
      return (d - notch(d)) / (d - floor + km)
    }
    expect(share(20)).toBeGreaterThan(0.13)
    expect(share(20)).toBeLessThan(0.14)
    expect(share(10)).toBeGreaterThan(0.1)
    expect(share(10)).toBeLessThan(0.12)
    expect(share(1)).toBeGreaterThan(0.079)
    expect(share(1)).toBeLessThan(0.081)
  })

  it('reaches the floor in a few dozen notches at most, never below it', () => {
    expect(notchesToFloor(EARTH_BARRIER)).toBe(52)
    expect(notchesToFloor(RE + 100 * km)).toBe(39)
    expect(notchesToFloor(RE + 20 * km)).toBe(30)
    expect(notchesToFloor(RE + 10 * km)).toBe(25)
    expect(notchesToFloor(RE + 2 * km)).toBe(9)
  })

  it('eases as much over the higher floor without reversed-Z depth', () => {
    const high = RE + closeZoomClearance(false)
    const notchesTo = (target: number, from: number) => {
      let d = from
      let n = 0
      while (d !== target && n < 100) {
        d = Math.max(d * 0.95 ** closeZoomSpeed(d, target), target)
        n++
      }
      return n
    }
    expect(notchesTo(high, high + 19 * km)).toBe(notchesTo(floor, floor + 19 * km))
  })

  it('never reverses, with the eye under the ground or at the centre', () => {
    expect(closeZoomSpeed(floor - 0.01, floor)).toBeGreaterThan(0)
    const atCentre = closeZoomSpeed(0, floor)
    expect(Number.isFinite(atCentre)).toBe(true)
    expect(atCentre).toBeGreaterThan(0)
  })

  describe("through OrbitControls' clamp", () => {
    const d0 = RE + 10 * km
    const controlsAt = (d: number) => {
      const camera = new PerspectiveCamera(30, 1.5, 1e-4, 4000)
      camera.position.set(0, 0, d)
      const controls = new OrbitControls(camera)
      controls.target.set(0, 0, 0)
      controls.minDistance = floor
      controls.maxDistance = 10 * RE
      controls.update()
      controls.zoomSpeed = closeZoomSpeed(d, floor)
      return controls
    }

    it('lands on the floor and stays there under held notches', () => {
      const controls = controlsAt(d0)
      for (let i = 0; i < 200; i++) {
        controls.dollyIn()
        expect(controls.getDistance()).toBeGreaterThanOrEqual(floor - 1e-12)
      }
      expect(controls.getDistance()).toBeCloseTo(floor, 12)
    })

    it('lands on the floor from a step far past it', () => {
      const controls = controlsAt(d0)
      controls.dollyIn(1e-6)
      expect(controls.getDistance()).toBeCloseTo(floor, 12)
    })

    it('lands on the floor from a wide pinch spread', () => {
      const controls = controlsAt(d0)
      controls.dollyOut(1000 ** controls.zoomSpeed)
      expect(controls.getDistance()).toBeCloseTo(floor, 12)
    })

    it('takes the same notches as the pure steps with the speed from the live distance', () => {
      const controls = controlsAt(d0)
      let n = 0
      while (Math.abs(controls.getDistance() - floor) > 1e-12 && n < 100) {
        controls.zoomSpeed = closeZoomSpeed(controls.getDistance(), floor)
        controls.dollyIn()
        expect(controls.getDistance()).toBeGreaterThanOrEqual(floor - 1e-12)
        n++
      }
      expect(n).toBe(notchesToFloor(d0))
    })
  })
})

describe('earthGroundRadius', () => {
  afterEach(() => setEarthTerrain(null))
  const at = (earth: Object3D, lat: number, lon: number) => {
    const { position } = calculateLocationAndRotationForLatLng(lat, lon, 1.2 * R)
    return earth.localToWorld(new Vector3(position.x, position.y, position.z))
  }

  it('reads the fixed sphere over any ground before the floor loads', () => {
    const earth = new Object3D()
    const up = new Vector3(0, 1, 0)
    expect(earthGroundRadius(earth, at(earth, 30, 88), R, 0)).toBe(terrainFloorRadius(null, R, up))
  })

  it("stands Tibet above the Pacific, in a spun Earth's own frame", async () => {
    const dem = await decodeEarthDem(readFileSync(new URL('./assets/earth-dem-mean.bin', import.meta.url)))
    setEarthTerrain(buildTerrainFloor(meanGrey(dem), EARTH_BASE_SEGMENTS))
    const earth = new Object3D()
    earth.position.set(50, 0, 0)
    earth.rotation.set(0.4, 1.3, 0)
    earth.updateMatrixWorld()
    const tibet = earthGroundRadius(earth, at(earth, 30, 88), R, 0)
    const pacific = earthGroundRadius(earth, at(earth, 0, -150), R, 0)
    expect(pacific).toBeGreaterThanOrEqual(R)
    expect(pacific - R).toBeLessThan(0.1 * (tibet - R))
    // Reading round a disc never lowers the ground.
    expect(earthGroundRadius(earth, at(earth, 30, 88), R, 0.05)).toBeGreaterThanOrEqual(tibet)
  })

  it("reads the limb sphere's floor while Earth's ground holds that sphere (tides-tvr.7.3)", () => {
    // Flat floors, the limb sphere's standing higher, to tell them apart.
    const level = (grey: number) => ({ width: 512, height: 256, data: new Float32Array(512 * 256).fill(grey) })
    setEarthTerrain(buildTerrainFloor(level(20), EARTH_BASE_SEGMENTS), buildTerrainFloor(level(120), LIMB_SEGMENTS))
    const earth = new Object3D()
    const p = at(earth, 30, 88)
    const base = earthGroundRadius(earth, p, R, 0)
    const release = retainLimbSphere(R, limbSphere(R))
    try {
      expect(earthGroundRadius(earth, p, R, 0)).toBeGreaterThan(base)
    } finally {
      release()
      disposeLimbSpheres()
    }
    expect(earthGroundRadius(earth, p, R, 0)).toBe(base)
  })
})

describe('earthGroundRadius over the streamed tiles', () => {
  afterEach(() => {
    setSurfaceGroundSampler(null)
    surfaceOpacityUniform.value = 0
  })
  const earth = new Object3D()
  earth.position.set(50, 0, 0)
  earth.rotation.set(0.4, 1.3, 0)
  earth.updateMatrixWorld()
  const p = (() => {
    const { position } = calculateLocationAndRotationForLatLng(30, 88, 1.2 * R)
    return earth.localToWorld(new Vector3(position.x, position.y, position.z))
  })()
  const angle = 0.01
  // The globe's ground there with no tiles: the fixed sphere (no floor loaded).
  const globe = earthGroundRadius(earth, p, R, angle)
  const tileGround = (metres: number) =>
    R + (metres + SURFACE_GROUND_MARGIN_METRES) * RELIEF * EARTH_UNITS_PER_METRE
  // Metres that stand the tiles above the globe's ground there.
  const above = (globe - R) / (RELIEF * EARTH_UNITS_PER_METRE) + 1000
  const fake = (answer: SurfaceGroundQuery | null) => {
    const calls: [number, number, number][] = []
    setSurfaceGroundSampler({
      maxElevation(lat, lon, radiusM) {
        calls.push([lat, lon, radiusM])
        return answer
      },
    })
    return calls
  }

  it('reads the globe without a sampler, or with the tiles dissolved out', () => {
    surfaceOpacityUniform.value = 1
    expect(earthGroundRadius(earth, p, R, angle)).toBe(globe)
    const calls = fake({ metres: 100, covered: true })
    surfaceOpacityUniform.value = 0
    expect(earthGroundRadius(earth, p, R, angle)).toBe(globe)
    expect(calls).toHaveLength(0)
  })

  it("takes the tiles' ground alone where they cover the window at full opacity, even below the globe's", () => {
    fake({ metres: 100, covered: true })
    surfaceOpacityUniform.value = 1
    expect(tileGround(100)).toBeLessThan(globe)
    expect(earthGroundRadius(earth, p, R, angle)).toBeCloseTo(tileGround(100), 12)
  })

  it('takes the higher of the two through the dissolve or where tiles are missing', () => {
    fake({ metres: 100, covered: true })
    surfaceOpacityUniform.value = 0.5
    expect(earthGroundRadius(earth, p, R, angle)).toBe(globe)
    fake({ metres: 100, covered: false })
    surfaceOpacityUniform.value = 1
    expect(earthGroundRadius(earth, p, R, angle)).toBe(globe)
    fake({ metres: above, covered: false })
    expect(earthGroundRadius(earth, p, R, angle)).toBeCloseTo(tileGround(above), 12)
    surfaceOpacityUniform.value = 0.5
    expect(earthGroundRadius(earth, p, R, angle)).toBeCloseTo(tileGround(above), 12)
  })

  it('reads the globe where no loaded tile reaches the window', () => {
    fake(null)
    surfaceOpacityUniform.value = 1
    expect(earthGroundRadius(earth, p, R, angle)).toBe(globe)
  })

  it("asks the sampler at the point's lat/lon in Earth's spun frame, over the window in metres", () => {
    const calls = fake({ metres: 0, covered: true })
    surfaceOpacityUniform.value = 1
    earthGroundRadius(earth, p, R, angle)
    expect(calls).toHaveLength(1)
    const [lat, lon, radiusM] = calls[0]
    expect(lat).toBeCloseTo((30 * Math.PI) / 180, 9)
    expect(lon).toBeCloseTo((88 * Math.PI) / 180, 9)
    expect(radiusM).toBeCloseTo((angle * R) / EARTH_UNITS_PER_METRE, 6)
  })
})

describe('mainNearFar nearMin', () => {
  it('keeps NEAR_MIN by default and drops to the floor it is given', () => {
    expect(mainNearFar(1e-5, 50).near).toBe(NEAR_MIN)
    expect(mainNearFar(1e-5, 50, undefined, NEAR_MIN_REVERSED).near).toBeCloseTo(5e-6, 12)
    expect(mainNearFar(1e-8, 50, undefined, NEAR_MIN_REVERSED).near).toBe(NEAR_MIN_REVERSED)
  })
})

describe('store close zoom', () => {
  afterEach(() => useStore.setState({ closeZoom: false, closeZoomTiles: false, timeScale: 1 }))

  it("writes the tiles' range only on a change", () => {
    useStore.getState().setCloseZoomTiles(true)
    const state = useStore.getState()
    expect(state.closeZoomTiles).toBe(true)
    useStore.getState().setCloseZoomTiles(true)
    expect(useStore.getState()).toBe(state)
    useStore.getState().setCloseZoomTiles(false)
    expect(useStore.getState().closeZoomTiles).toBe(false)
  })


  it('drops to real time on entering faster, with the cue', () => {
    useStore.setState({ timeScale: 3600, closeZoom: false })
    const cue = useStore.getState().realTimeCue
    useStore.getState().setCloseZoom(true)
    expect(useStore.getState()).toMatchObject({ closeZoom: true, timeScale: 1, realTimeCue: cue + 1 })
  })

  it('keeps paused paused on entering, without a cue', () => {
    useStore.setState({ timeScale: 0, closeZoom: false })
    const cue = useStore.getState().realTimeCue
    useStore.getState().setCloseZoom(true)
    expect(useStore.getState()).toMatchObject({ closeZoom: true, timeScale: 0, realTimeCue: cue })
  })

  it('refuses faster speeds while close, with the cue, and allows them again after', () => {
    useStore.setState({ timeScale: 1, closeZoom: false })
    useStore.getState().setCloseZoom(true)
    const cue = useStore.getState().realTimeCue
    useStore.getState().setTimeScale(86400)
    expect(useStore.getState()).toMatchObject({ timeScale: 1, realTimeCue: cue + 1 })
    useStore.getState().setTimeScale(0)
    expect(useStore.getState()).toMatchObject({ timeScale: 0, realTimeCue: cue + 1 })
    useStore.getState().setCloseZoom(false)
    useStore.getState().setTimeScale(86400)
    expect(useStore.getState().timeScale).toBe(86400)
  })

  it("leaves a demo's clock alone: entering at its speed, and its speeds while close", () => {
    useStore.setState({ timeScale: 43200, closeZoom: false, demo: { id: 'tour', step: 0 } })
    const cue = useStore.getState().realTimeCue
    useStore.getState().setCloseZoom(true)
    expect(useStore.getState()).toMatchObject({ closeZoom: true, timeScale: 43200, realTimeCue: cue })
    useStore.getState().setTimeScale(3600)
    expect(useStore.getState()).toMatchObject({ timeScale: 3600, realTimeCue: cue })
    useStore.setState({ demo: null })
  })

  it("doesn't notify when the flag is unchanged", () => {
    let calls = 0
    const unsubscribe = useStore.subscribe(() => calls++)
    useStore.getState().setCloseZoom(false)
    unsubscribe()
    expect(calls).toBe(0)
  })
})
