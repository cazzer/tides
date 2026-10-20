// The seven planets in the orbital views (tides-kzj.2.4). Mounted only while
// they are switched on, as siblings of the Sun, Earth and Moon: the camera
// reads a focused body's local position as its world position.
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type * as THREE from 'three'
import OrbitingBody from './OrbitingBody'
import {
  PLANETS,
  PLANET_KEYS,
  bodyOrientation,
  planetPosition,
  type PlanetKey,
} from './planets'
import { PLANET_RENDERERS } from './renderers/planets'
import { useStore } from './store'

export function PlanetBodies({ interactive }: { interactive: boolean }) {
  return (
    <>
      {PLANET_KEYS.map((key) => (
        <PlanetBody
          key={key}
          planetKey={key}
          interactive={interactive}
        />
      ))}
    </>
  )
}

function PlanetBody({
  planetKey,
  interactive,
}: {
  planetKey: PlanetKey
  interactive: boolean
}) {
  const { body, radius } = PLANETS[planetKey]
  const Renderer = PLANET_RENDERERS[planetKey]
  const ref = useRef<THREE.Mesh>(null)
  const positionAt = useMemo(() => planetPosition(body), [body])
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
        <Renderer />
      </Suspense>
    </OrbitingBody>
  )
}
