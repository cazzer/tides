import Sunlight from './Sunlight'
import { AMBIENT_COLOR, AMBIENT_INTENSITY } from '../lighting'

/** Sunlight and the faint night-side fill; levels in ../lighting.ts. */
export default function SceneLights() {
  return (
    <>
      <ambientLight
        color={AMBIENT_COLOR}
        intensity={AMBIENT_INTENSITY}
      />
      <Sunlight />
    </>
  )
}
