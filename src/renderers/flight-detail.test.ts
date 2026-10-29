import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { flightDetail } from './flight-detail'

describe('flight detail (tides-tvr.7.3)', () => {
  const main = new THREE.PerspectiveCamera()
  const panel = new THREE.PerspectiveCamera()

  it('is on in ship mode, whatever the limb view', () => {
    expect(flightDetail(true, null, null, main)).toBe(true)
    expect(flightDetail(true, 'moon', panel, main)).toBe(true)
  })

  it('is on out of ship mode only for the camera the view fed Earth for', () => {
    expect(flightDetail(false, 'earth', main, main)).toBe(true)
    expect(flightDetail(false, 'earth', main, panel)).toBe(false)
    expect(flightDetail(false, 'moon', main, main)).toBe(false)
    expect(flightDetail(false, null, null, main)).toBe(false)
  })
})
