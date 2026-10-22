import { Suspense, useRef, useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useTexture } from '@react-three/drei'
import OrbitingBody from './OrbitingBody'
import SunRenderer from './renderers/SunRenderer'
import EarthRenderer from './renderers/EarthRenderer'
import AuroraRenderer from './renderers/AuroraRenderer'
import AtmosphereRenderer from './renderers/AtmosphereRenderer'
import MoonRenderer from './renderers/MoonRenderer'
import Starfield from './renderers/Starfield'
import ConstellationLines from './renderers/ConstellationLines'
import ConstellationArt from './renderers/ConstellationArt'
import SceneLights from './renderers/SceneLights'
import { Body } from 'astronomy-engine'
import { CameraProvider } from './camera'
import { mainViewRange } from './main-view'
import { OrbitLabel } from './orbit-label'
import { LunarRing } from './LunarRing'
import { ZodiacRing } from './ZodiacRing'
import { PlanetBodies } from './PlanetBodies'
import { EarthOrbit, PlanetOrbits } from './planet-orbits'
import { MoonBodies } from './moons/MoonBodies'
import { SystemAids } from './system-aids/SystemAids'
import type { DistanceScale } from './distance-scale'
import { positionsFor } from './flight-scale'
import { RoundSkyDiscs } from './RoundSkyDiscs'
import { SkyLookControls } from './SkyLookControls'
import { sceneRadius } from './planets'
import { useStore } from './store'
import {
  DEFAULT_SURFACE_LOCATION,
  MOON_SKY_DISTANCE,
  SUN_SKY_DISTANCE,
  skyPositionAt,
} from './sky'

import earthTextureHigh from './assets/earth-day.jpg'
import earthTextureLow from './assets/earth-day-2k.jpg'
import moonTextureHigh from './assets/moon.jpg'
import moonTextureLow from './assets/moon-2k.jpg'
import {
  EARTH_ORBIT_RADIUS,
  earthSpin,
  earthTilt,
  moonOrientation,
  sunOrientation,
} from './ephemeris'

const EARTH_DIAMETER = sceneRadius(12742000)

useTexture.preload(earthTextureHigh)

export default function SolarSystem({
  earthCamera = false,
  moonCamera = false,
  interactive = false,
  showOrbitLabels,
  calendar = true,
  starRadius,
  distanceScale = 'system',
  ship = false,
}: {
  earthCamera?: boolean
  moonCamera?: boolean
  interactive?: boolean
  showOrbitLabels?: boolean
  /** The clock text and month names on Earth's orbit line (off in ship mode). */
  calendar?: boolean
  /** Overrides the starfield's radius (ship mode's camera roams the system). */
  starRadius?: number
  /** The planets' spacing: ship mode flies at 'flight' (tides-2hv.6). */
  distanceScale?: DistanceScale
  /** In ship mode, for the parts that look different there. */
  ship?: boolean
}) {
  const earthTexture = getEarthTexture()
  const moonTexture = getMoonTexture()
  useTexture.preload(earthTexture)
  useTexture.preload(moonTexture)
  const setPlanet = useStore((s) => s.setPlanet)
  const sun = useRef(null)
  const earth = useRef(null)
  const moon = useRef(null)
  const skyDiscs = useMemo(() => [sun, moon], [])
  const location = useStore((s) => s.location)
  const showPlanets = useStore((s) => s.showPlanets)
  const showConstellations = useStore((s) => s.showConstellations)
  const showConstellationArt = useStore((s) => s.showConstellationArt)
  const showLunar = useStore((s) => s.showLunar)
  const showZodiac = useStore((s) => s.showZodiac)
  const { lat, lon } = location ?? DEFAULT_SURFACE_LOCATION
  const positions = positionsFor(distanceScale)

  // From the surface, the Sun and Moon move to their true directions on a sky
  // around the observer (see sky.ts).
  const sunPositionAt = useMemo(
    () =>
      earthCamera
        ? skyPositionAt(Body.Sun, SUN_SKY_DISTANCE, lat, lon, EARTH_DIAMETER)
        : undefined,
    [earthCamera, lat, lon]
  )
  const moonPositionAt = useMemo(
    () =>
      earthCamera
        ? skyPositionAt(Body.Moon, MOON_SKY_DISTANCE, lat, lon, EARTH_DIAMETER)
        : positions.positionAt.moon,
    [earthCamera, lat, lon, positions]
  )

  // Only the main panel's CameraProvider (the one with OrbitControls) uses these.
  useEffect(() => {
    if (!interactive) return
    setPlanet('earth', earth)
    setPlanet('sun', sun)
    setPlanet('moon', moon)
  }, [interactive])

  return (
    <CameraProvider>
      <SceneLights />

      {/* Only the main view widens for the planets. */}
      <Starfield
        fromSurface={earthCamera}
        radius={starRadius ?? mainViewRange(interactive && showPlanets).starRadius}
        depth={interactive}
      />
      {earthCamera && showConstellations && showConstellationArt && <ConstellationArt />}
      {earthCamera && showConstellations && <ConstellationLines />}
      {earthCamera && <RoundSkyDiscs bodies={skyDiscs} />}
      {earthCamera && <SkyLookControls />}

      <OrbitingBody
        ref={sun}
        focusKey="sun"
        positionAt={sunPositionAt}
        orientationAt={sunOrientation}
        interactive={interactive}
      >
        <SunRenderer
          diameter={sceneRadius(1392700000)}
        />
      </OrbitingBody>
      <OrbitingBody
        surfaceCamera={earthCamera}
        moonCamera={moonCamera}
        ref={earth}
        focusKey="earth"
        storeLabel="earth"
        diameter={EARTH_DIAMETER}
        positionAt={positions.positionAt.earth}
        spinAt={earthSpin}
        tiltAt={earthTilt}
        interactive={interactive}
      >
        {/* From the surface, the ground stands in for the globe. */}
        {!earthCamera && (
          <EarthRenderer
            diameter={EARTH_DIAMETER}
            texture={earthTexture}
          />
        )}
        {!earthCamera && <AtmosphereRenderer radius={EARTH_DIAMETER} />}
        {!earthCamera && <AuroraRenderer radius={EARTH_DIAMETER} />}
      </OrbitingBody>
      {/* The month ring is a circle at the system Earth's radius; in flight
          Earth follows its true, slightly eccentric orbit, drawn as such. */}
      {showOrbitLabels && distanceScale === 'system' && (
        <OrbitLabel
          radius={EARTH_ORBIT_RADIUS}
          calendar={calendar}
        />
      )}
      {showOrbitLabels && distanceScale === 'flight' && (
        <EarthOrbit distanceScale={distanceScale} />
      )}
      {/* Calendar rings round the Sun at system radii, so system view only. */}
      {showOrbitLabels && distanceScale === 'system' && showLunar && <LunarRing />}
      {showOrbitLabels && distanceScale === 'system' && showZodiac && <ZodiacRing />}
      <OrbitingBody
        ref={moon}
        focusKey="moon"
        diameter={sceneRadius(3474800)}
        positionAt={moonPositionAt}
        orientationAt={moonOrientation}
        interactive={interactive}
      >
        <MoonRenderer
          diameter={sceneRadius(3474800)}
          texture={moonTexture}
        />
      </OrbitingBody>
      {/* Orbital views only; their textures must not suspend the scene. */}
      {showPlanets && !earthCamera && !moonCamera && (
        <>
          <Suspense fallback={null}>
            <PlanetBodies
              interactive={interactive}
              distanceScale={distanceScale}
            />
          </Suspense>
          {/* Siblings, so one loading never hides the other. */}
          <Suspense fallback={null}>
            <MoonBodies
              interactive={interactive}
              distanceScale={distanceScale}
            />
          </Suspense>
          <Suspense fallback={null}>
            <SystemAids
              distanceScale={distanceScale}
              ship={ship}
            />
          </Suspense>
        </>
      )}
      {showPlanets && showOrbitLabels && !earthCamera && !moonCamera && (
        <PlanetOrbits distanceScale={distanceScale} />
      )}
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
