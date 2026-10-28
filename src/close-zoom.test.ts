import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Object3D, Vector3 } from 'three'
import {
  CLOSE_ZOOM_HYSTERESIS,
  closeZoomClearance,
  closeZoomFloor,
  closeZoomSpeed,
  earthGroundRadius,
  isCloseZoom,
} from './close-zoom'
import { MIN_DISTANCE_FACTOR, NEAR_MIN, mainNearFar } from './main-view'
import { EARTH_KM_PER_UNIT } from './surface-handover'
import { NEAR_MIN as SHIP_NEAR_MIN, NEAR_MIN_REVERSED } from './ship/ship-session'
import {
  EARTH_BASE_SEGMENTS,
  buildTerrainFloor,
  meanGrey,
  setEarthTerrain,
  terrainFloorRadius,
} from './ship/terrain-floor'
import { decodeEarthDem } from './earth-dem'
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
  const gT = R
  it('is a whole step at the barrier and above', () => {
    expect(closeZoomSpeed(BARRIER, gT)).toBeCloseTo(1, 12)
    expect(closeZoomSpeed(2 * BARRIER, gT)).toBe(1)
  })

  it('falls continuously below it', () => {
    let previous = closeZoomSpeed(BARRIER, gT)
    for (let d = BARRIER; d > gT + 1e-4; d = gT + (d - gT) * 0.9) {
      const speed = closeZoomSpeed(d, gT)
      expect(speed).toBeLessThanOrEqual(previous)
      expect(previous - speed).toBeLessThan(0.11 * previous + 1e-9)
      previous = speed
    }
  })

  it('cuts 17-20% of the altitude a wheel notch, from the barrier to a kilometre', () => {
    const km = 1 / EARTH_KM_PER_UNIT
    for (let d = BARRIER; d > gT + km; d = gT + (d - gT) * 0.7) {
      const next = d * 0.95 ** closeZoomSpeed(d, gT)
      const cut = 1 - (next - gT) / (d - gT)
      expect(cut).toBeGreaterThan(0.17)
      expect(cut).toBeLessThan(0.2)
    }
    const d = gT + km
    const cut = 1 - (d * 0.95 ** closeZoomSpeed(d, gT) - gT) / km
    expect(cut).toBeGreaterThan(0.17)
    expect(cut).toBeLessThan(0.2)
  })

  it('never reverses, with the eye under the ground', () => {
    expect(closeZoomSpeed(gT - 0.01, gT)).toBeGreaterThan(0)
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
})

describe('mainNearFar nearMin', () => {
  it('keeps NEAR_MIN by default and drops to the floor it is given', () => {
    expect(mainNearFar(1e-5, 50).near).toBe(NEAR_MIN)
    expect(mainNearFar(1e-5, 50, undefined, NEAR_MIN_REVERSED).near).toBeCloseTo(5e-6, 12)
    expect(mainNearFar(1e-8, 50, undefined, NEAR_MIN_REVERSED).near).toBe(NEAR_MIN_REVERSED)
  })
})

describe('store close zoom', () => {
  afterEach(() => useStore.setState({ closeZoom: false, timeScale: 1 }))

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

  it("doesn't notify when the flag is unchanged", () => {
    let calls = 0
    const unsubscribe = useStore.subscribe(() => calls++)
    useStore.getState().setCloseZoom(false)
    unsubscribe()
    expect(calls).toBe(0)
  })
})
