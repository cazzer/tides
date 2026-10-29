import { Suspense, lazy, useRef, useEffect, useMemo } from 'react'
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
import { CameraProvider } from './camera'
import { PLANETS_STAR_RADIUS } from './main-view'
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
import { isLowQuality } from './quality'
import { SURFACE_TILES_ON } from './surface'
import { systemSurfaceTilesOn } from './close-zoom-rules'
import {
  DEFAULT_SURFACE_LOCATION,
  eclipseDemoSkyScale,
  everydaySkyScale,
  skyDiscPositionsAt,
} from './sky'
import { useDemoAid } from './demo/demo-aids'
import { MoonOrbitTilt } from './demo/MoonOrbitTilt'
import { MoonShadowGlobe } from './demo/MoonShadowGlobe'
import { SeasonsGlobe } from './demo/SeasonsGlobe'
import { shownEarthSpin } from './demo/demo-travel'
import { TidesField } from './demo/TidesField'
import { TidesSpot } from './demo/TidesSpot'
import { EclipseDaylight } from './EclipseDaylight'
import { coronaFade, eclipseSkyAt } from './eclipse-sky'

import earthTextureHigh from './assets/earth-day.jpg'
import earthTextureLow from './assets/earth-day-2k.jpg'
import moonTextureHigh from './assets/moon.jpg'
import moonTextureLow from './assets/moon-2k.jpg'
import {
  EARTH_ORBIT_RADIUS,
  earthTilt,
  moonOrientation,
  sunOrientation,
} from './ephemeris'

const EARTH_DIAMETER = sceneRadius(12742000)

// The streamed surface (tides-zmw.9.1) loads its own chunk, the tiles library
// with it, and only on the high tier unless ?surface=0: in ship mode, and in
// the main view's close zoom over Earth (tides-tvr.7.2).
const SurfaceTiles = lazy(() => import('./renderers/surface/SurfaceTiles'))

useTexture.preload(getEarthTexture())

export default function SolarSystem({
  earthCamera = false,
  moonCamera = false,
  interactive = false,
  showOrbitLabels,
  calendar = true,
  starRadius,
  distanceScale = 'system',
  ship = false,
  mainSlot = false,
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
  /** The view holds the main grid slot, where its overlay (the tiles' credits) shows. */
  mainSlot?: boolean
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
  const systemTiles = useStore((s) =>
    systemSurfaceTilesOn({
      tilesOn: SURFACE_TILES_ON,
      interactive,
      mainSlot,
      closeZoomTiles: s.closeZoomTiles,
      cameraFocus: s.cameraFocus,
    })
  )
  const showZodiac = useStore((s) => s.showZodiac)
  const { lat, lon } = location ?? DEFAULT_SURFACE_LOCATION
  const positions = positionsFor(distanceScale)
  // The demos' aids (demo-aids.ts); off outside them.
  const eclipseSky = useDemoAid('solarEclipseSky') && earthCamera
  const moonNodes = useDemoAid('moonNodes')
  const seasons = useDemoAid('seasons')
  const tides = useDemoAid('tides')
  // The globe's clouds give way to it (tides-zec.7.1).
  const moonShadowShown = useDemoAid('moonShadow') && interactive && !ship
  // A demo travel may hide the Moon, which a fast clock would smear round
  // Earth; only its look goes, so its body, refs and camera carry on.
  const moonHidden = useStore((s) => s.demoTravel?.hideMoon ?? false)

  // From the surface, the Sun and Moon move to a sky around the observer, both
  // at one scale (see sky.ts): SKY_SCALE, or the solar eclipse demo's own.
  const skyPositions = useMemo(
    () =>
      earthCamera
        ? skyDiscPositionsAt(
            lat,
            lon,
            EARTH_DIAMETER,
            positions.radius,
            eclipseSky ? eclipseDemoSkyScale(positions.radius.sun) : everydaySkyScale
          )
        : undefined,
    [earthCamera, eclipseSky, lat, lon, positions]
  )
  const sunPositionAt = skyPositions?.sun
  const moonPositionAt = skyPositions?.moon ?? positions.positionAt.moon
  // The corona shows only while the Moon hides the Sun, in every View from Earth.
  const coronaFadeAt = useMemo(
    () =>
      earthCamera
        ? () => {
            // The clock OrbitingBody and EclipseDaylight read, so all hit eclipseSkyAt's cache.
            const t = useStore.getState().timestamp ?? Date.now()
            return coronaFade(eclipseSkyAt(t, lat, lon).visible)
          }
        : undefined,
    [earthCamera, lat, lon]
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
        radius={starRadius ?? (interactive && showPlanets ? PLANETS_STAR_RADIUS : undefined)}
        depth={interactive}
      />
      {earthCamera && showConstellations && showConstellationArt && <ConstellationArt />}
      {earthCamera && showConstellations && <ConstellationLines />}
      {earthCamera && <RoundSkyDiscs bodies={skyDiscs} />}
      {eclipseSky && (
        <EclipseDaylight
          lat={lat}
          lon={lon}
        />
      )}
      {earthCamera && <SkyLookControls />}

      <OrbitingBody
        ref={sun}
        focusKey="sun"
        positionAt={sunPositionAt}
        orientationAt={sunOrientation}
        interactive={interactive}
      >
        <SunRenderer
          diameter={positions.radius.sun}
          interactive={interactive}
          coronaFade={coronaFadeAt}
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
        spinAt={shownEarthSpin}
        tiltAt={earthTilt}
        interactive={interactive}
      >
        {/* From the surface, the ground stands in for the globe. */}
        {!earthCamera && (
          <EarthRenderer
            diameter={EARTH_DIAMETER}
            texture={earthTexture}
            hideClouds={moonShadowShown}
          />
        )}
        {!earthCamera && <AtmosphereRenderer radius={EARTH_DIAMETER} />}
        {!earthCamera && <AuroraRenderer radius={EARTH_DIAMETER} />}
        {seasons && interactive && !earthCamera && !ship && <SeasonsGlobe radius={EARTH_DIAMETER} />}
        {tides && interactive && !earthCamera && !moonCamera && !ship && distanceScale === 'system' && (
          <TidesSpot radius={EARTH_DIAMETER} />
        )}
        {moonShadowShown && !earthCamera && <MoonShadowGlobe radius={EARTH_DIAMETER} />}
        {/* Under Earth's spin like the globe; its own Suspense, so the chunk
            loading never hides Earth. */}
        {(ship ? SURFACE_TILES_ON : systemTiles) && (
          <Suspense fallback={null}>
            <SurfaceTiles eye={ship ? 'ship' : 'system'} />
          </Suspense>
        )}
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
        diameter={positions.radius.moon}
        positionAt={moonPositionAt}
        orientationAt={moonOrientation}
        interactive={interactive}
      >
        <group visible={!moonHidden}>
          <MoonRenderer
            diameter={positions.radius.moon}
            texture={moonTexture}
          />
        </group>
      </OrbitingBody>
      {moonNodes && interactive && !earthCamera && !moonCamera && distanceScale === 'system' && (
        <MoonOrbitTilt />
      )}
      {tides && interactive && !earthCamera && !moonCamera && !ship && distanceScale === 'system' && (
        <TidesField radius={EARTH_DIAMETER} />
      )}
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
  return isLowQuality() ? moonTextureLow : moonTextureHigh
}

function getEarthTexture() {
  return isLowQuality() ? earthTextureLow : earthTextureHigh
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
