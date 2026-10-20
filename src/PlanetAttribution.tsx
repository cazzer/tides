const SOLAR_SYSTEM_SCOPE_URL = 'https://www.solarsystemscope.com/textures/'
const CC_BY_URL = 'https://creativecommons.org/licenses/by/4.0/'

/** Credit the planet textures, as CC BY 4.0 requires. Mount only while planets show. */
export function PlanetAttribution() {
  return (
    <p className="planet-attribution">
      Planet textures:{' '}
      <a
        href={SOLAR_SYSTEM_SCOPE_URL}
        target="_blank"
        rel="noreferrer"
      >
        Solar System Scope
      </a>{' '}
      (
      <a
        href={CC_BY_URL}
        target="_blank"
        rel="noreferrer"
        title="Creative Commons Attribution 4.0 International"
      >
        CC BY 4.0
      </a>
      )
    </p>
  )
}
