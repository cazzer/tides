import styled from 'styled-components'
import { PLANET_KEYS, PLANETS } from '../planets'
import { MARKER_DOT_PX, bodyMarkers } from './body-markers'

// Earth isn't in PLANETS; this is its ocean blue from the system view's dot.
const EARTH_COLOR = '#4f8fe0'
// As the target brackets.
const TARGET_COLOR = '#8fd8ff'

const MARKED: readonly { key: string; color: string }[] = [
  { key: 'earth', color: EARTH_COLOR },
  ...PLANET_KEYS.map((key) => ({ key, color: PLANETS[key].color })),
]

/**
 * Minimum-size dots for Earth and the planets, and for a targeted moon
 * (tides-2hv.12; see body-markers.ts), all hidden until ShipTargeting places
 * them each frame. Render inside the HUD's marker layer, under the target
 * brackets.
 */
export function BodyMarkers() {
  return (
    <>
      {MARKED.map(({ key, color }) => (
        <Dot
          key={key}
          ref={(element) => {
            if (!element) return
            bodyMarkers.planets.set(key, element)
            return () => {
              bodyMarkers.planets.delete(key)
            }
          }}
          style={{ backgroundColor: color }}
          hidden
        />
      ))}
      <Dot
        ref={(element) => {
          bodyMarkers.moon = element
          return () => {
            bodyMarkers.moon = null
          }
        }}
        style={{ backgroundColor: TARGET_COLOR }}
        hidden
      />
    </>
  )
}

const Dot = styled.span`
  position: absolute;
  top: 0;
  left: 0;
  width: ${MARKER_DOT_PX}px;
  height: ${MARKER_DOT_PX}px;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.65);
  will-change: transform;

  &[hidden] {
    display: none;
  }
`
