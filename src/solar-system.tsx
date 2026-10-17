import { useRef, useEffect } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import { DateTime } from 'luxon'
import OrbitingBody from './OrbitingBody'
import SunRenderer from './renderers/SunRenderer'
import EarthRenderer from './renderers/EarthRenderer'
import MoonRenderer from './renderers/MoonRenderer'
import Starfield from './renderers/Starfield'
import { scaleLog, scaleLinear, easeExpInOut } from 'd3'
import suncalc from 'suncalc'
import { CameraProvider } from './camera'
import { useStore } from './store'

import earthTextureHigh from './assets/earth-day.jpg'
import earthTextureLow from './assets/earth-day-2k.jpg'
import moonTextureHigh from './assets/moon.jpg'
import moonTextureLow from './assets/moon-2k.jpg'
import { degreesToRadians, interpolateValue, trueAnomalyToMeanAnomaly } from './utils'

const scaleDiameter = scaleLog().domain([3474800, 1392700000]).range([1, 10])
const scaleOrbit = scaleLinear()
  .domain([384400000, 149597870700])
  .range([10, 50])

const EARTH_SOLAR_DAY_MS = 24 * 3600000
const EARTH_SIDEREAL_YEAR_MS = 365.256363004 * 24 * 3600000
const MOON_SIDEREAL_PERIOD_MS = 27.321661 * 24 * 3600000
const JUMP_DURATION_MS = 5000

useTexture.preload(earthTextureHigh)

export default function SolarSystem({
  earthCamera = false,
  moonCamera = false,
  interactive = false,
  showOrbitLabels,
}: {
  earthCamera?: boolean
  moonCamera?: boolean
  interactive?: boolean
  showOrbitLabels?: boolean
}) {
  const earthTexture = getEarthTexture()
  const moonTexture = getMoonTexture()
  useTexture.preload(earthTexture)
  useTexture.preload(moonTexture)
  const { setPlanet, timeScale, jumpDate, jumpDateSetAt, setJumpDate } =
    useStore()
  const sun = useRef(null)
  const earth = useRef(null)
  const moon = useRef(null)

  useEffect(() => {
    setPlanet('earth', earth)
    setPlanet('sun', sun)
    setPlanet('moon', moon)
  }, [])

  useFrame((state, delta) => {
    const simulationState = state as typeof state & {
      timestamp?: number
      startJumpAt?: number | null
      startJumpClock?: number | null
    }
    const currentTimestamp =
      typeof simulationState.timestamp === 'number'
        ? simulationState.timestamp
        : Date.now()
    let newTime

    if (jumpDate) {
      if (!simulationState.startJumpAt) {
        simulationState.startJumpAt = currentTimestamp
        simulationState.startJumpClock = state.clock.elapsedTime
      }

      const jumpDateMillis = jumpDate.getTime()
      const jumpStartClock = simulationState.startJumpClock ?? state.clock.elapsedTime
      const jumpElapsedMs = (state.clock.elapsedTime - jumpStartClock) * 1000
      const jumpProgress = Math.min(1, Math.max(0, jumpElapsedMs / JUMP_DURATION_MS))
      newTime = interpolateValue(
        simulationState.startJumpAt ?? currentTimestamp,
        jumpDateMillis,
        jumpProgress,
        easeExpInOut
      )
      if (jumpProgress >= 1) {
        setJumpDate(null)
        simulationState.startJumpAt = null
        simulationState.startJumpClock = null
      }
    } else {
      newTime = currentTimestamp + delta * 1000 * timeScale
    }

    state.set({
      // @ts-ignore
      timestamp: newTime,
    })
  })

  const start = DateTime.utc(2024, 1, 1, 0, 0, 0)
  const epochMs = start.toMillis()
  const end = DateTime.utc(2024, 12, 31, 23, 59, 59)
  const summerSolstice = DateTime.utc(2024, 6, 20, 20, 51, 0)

  const angle =
    ((summerSolstice.toMillis() - start.toMillis()) /
      (end.toMillis() - start.toMillis())) *
      Math.PI *
      2 -
    Math.PI / 2

  const earthArgumentOfPeriapsisDeg = 102.9372
  const earthInitialTrueAnomaly = -angle - degreesToRadians(earthArgumentOfPeriapsisDeg)
  const earthMeanAnomalyAtEpoch = trueAnomalyToMeanAnomaly(
    earthInitialTrueAnomaly,
    0.0167
  )

  const moonArgumentOfPeriapsisDeg = 318.15
  const moonAscendingNodeDeg = 125.08
  const moonInitialTrueAnomaly =
    degreesToRadians(-8) - degreesToRadians(moonArgumentOfPeriapsisDeg)
  const moonMeanAnomalyAtEpoch = trueAnomalyToMeanAnomaly(
    moonInitialTrueAnomaly,
    0.0549
  )

  const earthOffset = suncalc.getPosition(new Date(), 0, 0)
  const earthRotationOffset = 2 * Math.PI * earthOffset.azimuth

  return (
    <CameraProvider>
      <ambientLight intensity={1} />

      <Starfield />

      <OrbitingBody
        ref={sun}
        focusKey="sun"
        rotationPeriod={609.12 * 3600000}
        interactive={interactive}
      >
        <SunRenderer
          diameter={scaleDiameter(1392700000)}
        />
      </OrbitingBody>
      <OrbitingBody
        surfaceCamera={earthCamera}
        moonCamera={moonCamera}
        ref={earth}
        focusKey="earth"
        storeLabel="earth"
        parent={sun}
        showOrbit={showOrbitLabels}
        diameter={scaleDiameter(12742000)}
        rotationPeriod={EARTH_SOLAR_DAY_MS}
        rotationEpochMs={epochMs}
        orbitalDistance={scaleOrbit(149597870700)}
        orbitalPeriod={EARTH_SIDEREAL_YEAR_MS}
        orbitOffset={angle}
        orbitEpochMs={epochMs}
        keplerOrbit={{
          semiMajorAxis: scaleOrbit(149597870700),
          eccentricity: 0.0167,
          inclinationDeg: 0,
          ascendingNodeDeg: 0,
          argumentOfPeriapsisDeg: earthArgumentOfPeriapsisDeg,
          meanAnomalyAtEpochRad: earthMeanAnomalyAtEpoch,
        }}
        rotationOffset={earthRotationOffset}
        axialTilt={23.4}
        interactive={interactive}
      >
        <EarthRenderer
          diameter={scaleDiameter(12742000)}
          texture={earthTexture}
        />
      </OrbitingBody>
      <OrbitingBody
        ref={moon}
        focusKey="moon"
        parent={earth}
        diameter={scaleDiameter(3474800)}
        orbitalPeriod={MOON_SIDEREAL_PERIOD_MS}
        orbitEpochMs={epochMs}
        keplerOrbit={{
          semiMajorAxis: scaleOrbit(384400000),
          eccentricity: 0.0549,
          inclinationDeg: 5.145,
          ascendingNodeDeg: moonAscendingNodeDeg,
          argumentOfPeriapsisDeg: moonArgumentOfPeriapsisDeg,
          meanAnomalyAtEpochRad: moonMeanAnomalyAtEpoch,
        }}
        rotationPeriod={MOON_SIDEREAL_PERIOD_MS}
        rotationEpochMs={epochMs}
        rotationOffset={2.5}
        axialTilt={-1.53}
        interactive={interactive}
      >
        <MoonRenderer
          diameter={scaleDiameter(3474800)}
          texture={moonTexture}
        />
      </OrbitingBody>
    </CameraProvider>
  )
}

function getMoonTexture() {
  if (typeof window === 'undefined') return moonTextureHigh
  const quality = getQualityOverride()
  const isMobile = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent)
  const useLow = quality === 'low' || (quality !== 'high' && isMobile)
  return useLow ? moonTextureLow : moonTextureHigh
}

function getEarthTexture() {
  if (typeof window === 'undefined') return earthTextureHigh
  const quality = getQualityOverride()
  const isMobile = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent)
  const useLow = quality === 'low' || (quality !== 'high' && isMobile)
  return useLow ? earthTextureLow : earthTextureHigh
}

function getQualityOverride() {
  if (typeof window === 'undefined') return null
  const value = new URLSearchParams(window.location.search).get('quality')
  if (value === 'low' || value === 'high') return value
  return null
}

function fitCameraToObjects(camera, objects, controls) {
  const offset = 1

  const boundingBox = new THREE.Box3()

  // get bounding box of object - this will be used to setup controls and camera>
  objects.forEach((object: any) => {
    boundingBox.expandByObject(object)
  })

  const center = new THREE.Vector3()
  boundingBox.getCenter(center)

  const size = new THREE.Vector3()
  boundingBox.getSize(size)

  // get the max side of the bounding box (fits to width OR height as needed )
  const maxDim = Math.max(size.x, size.y, size.z)
  const fov = 50 * (Math.PI / 180)
  // let cameraZ = Math.abs((maxDim / 4) * Math.tan(fov * 2))
  let cameraZ = 100

  cameraZ *= offset // zoom out a little so that objects don't fill the screen

  camera.position.z = center.z
  camera.position.x = center.x + 30
  camera.position.y = 100

  const minZ = boundingBox.min.z
  const cameraToFarEdge = minZ < 0 ? -minZ + cameraZ : cameraZ - minZ

  camera.far = cameraToFarEdge * 3
  camera.updateProjectionMatrix()

  if (controls) {
    // set camera to rotate around center of loaded object
    // controls.target = new THREE.Vector3(0, 0, 0)
    controls.target = center

    // prevent camera from zooming out far enough to create far plane cutoff
    controls.maxDistance = cameraToFarEdge * 2

    controls.saveState()
  } else {
    camera.lookAt(center)
  }
}
