// The seven planets in the orbital views (tides-kzj.2.4). Mounted only while
// they are switched on, as siblings of the Sun, Earth and Moon: the camera
// reads a focused body's local position as its world position.
import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type FC,
} from 'react'
import type * as THREE from 'three'
import OrbitingBody from './OrbitingBody'
import {
  PLANETS,
  PLANET_KEYS,
  bodyOrientation,
  type PlanetKey,
} from './planets'
import { PLANET_RENDERERS } from './renderers/planets'
import { useStore } from './store'
import type { DistanceScale } from './distance-scale'
import { positionsFor } from './flight-scale'

export const PlanetBodies: FC<{
  interactive: boolean
  distanceScale: DistanceScale
}> = ({ interactive, distanceScale }) => (
  <>
    {PLANET_KEYS.map((key) => (
      <PlanetBody
        key={key}
        planetKey={key}
        interactive={interactive}
        distanceScale={distanceScale}
      />
    ))}
  </>
)

function PlanetBody({
  planetKey,
  interactive,
  distanceScale,
}: {
  planetKey: PlanetKey
  interactive: boolean
  distanceScale: DistanceScale
}) {
  const { positionAt: positionsAt, radius: radii } = positionsFor(distanceScale)
  const positionAt = positionsAt[planetKey]
  const radius = radii[planetKey]
  // The catalog planet at this scale's radius (flight's differs only under
  // ?truescale, flight-scale.ts): the renderers size the globe, its rings
  // and atmosphere by planet.radius.
  const planet = useMemo(() => ({ ...PLANETS[planetKey], radius }), [planetKey, radius])
  const { body } = planet
  const Renderer = PLANET_RENDERERS[planetKey]
  const ref = useRef<THREE.Mesh>(null)
  const orientationAt = useMemo(() => bodyOrientation(body), [body])
  const setPlanet = useStore((s) => s.setPlanet)

  // The camera frames a focused planet by this radius.
  useLayoutEffect(() => {
    if (ref.current) ref.current.userData.radius = radius
  }, [radius])

  // Only the main panel's camera focuses bodies.
  useEffect(() => {
    if (!interactive) return
    setPlanet(planetKey, ref)
    return () => setPlanet(planetKey, undefined)
  }, [interactive, planetKey, setPlanet])

  return (
    <OrbitingBody
      ref={ref}
      focusKey={planetKey}
      positionAt={positionAt}
      orientationAt={orientationAt}
      interactive={interactive}
    >
      {/* The body registers (and can be focused) while its textures load.
          Anything else that suspends here (e.g. drei Text) needs its own
          Suspense beside this one, so a font load doesn't hide the globe
          or a texture load the text. */}
      <Suspense fallback={null}>
        <Renderer planet={planet} />
      </Suspense>
    </OrbitingBody>
  )
}
