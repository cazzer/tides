# Orbit accuracy (tides-b5i)

Is the scene's orbital and rotation math right? Every body's position and
orientation was read back from the transforms `OrbitingBody` applies (the same
`positionAt` / `spinAt` / `tiltAt` / `orientationAt` that `solar-system.tsx` and
`PlanetBodies.tsx` pass) and compared with JPL Horizons at twelve epochs:
1900, 1950, J2000, the 2026 perihelion, both 2026 equinoxes and solstices, the
2026-10-07 lunar node crossing, 2026-10-20, 2050 and 2100.

Reproduce: `npx vitest run src/orbit-accuracy.test.ts` (asserts the
tolerances); `ORBIT_REPORT=1` in front also regenerates the tables below.
Reference data: `node scripts/fetch-orbitcheck-fixtures.mjs` →
`src/__fixtures__/horizons-orbitcheck.json`.

## Verdict

**Yes: the math is right, now to within about 0.01° for every body over
1900–2100.** Directions (ecliptic longitude/latitude of the Sun, Moon and
planets), the Earth's spin, tilt and sub-solar point, the Moon's libration and
pole, and every planet's pole and prime meridian agree with Horizons to
≤ 0.007° for the Earth, Moon and Sun and ≤ 0.03° for the planets (the worst
being Uranus's rotation in 1900, where the IAU rotation model is loosest).
That is far below what the scene can show: the Moon's disc is 0.5° wide as
seen from Earth.

Three subtle errors were found and fixed on this branch:

| Issue | Worst before | After | Fix |
|---|---|---|---|
| ΔT (TT − UT) extrapolated by astronomy-engine's Espenak–Meeus polynomial: 75.5 s today vs the true 69.2 s, 203 s by 2100. The app's timestamps are UTC, so TT − UTC is exactly 32.184 s + leap seconds. | Jupiter's rotation 0.06° off today, 1.34° in 2100; the Moon 0.0216° in 2100 | Jupiter ≤ 0.011°, Moon 0.0006° | `src/delta-t.ts`: ΔT from the leap-second table since 1972 (the default before). Horizons makes the same assumption for future dates. |
| Earth tilted by a fixed 23.4393° (J2000 mean obliquity), while the scene's frame and the stars are the true ecliptic of date | sub-solar latitude 0.012° (1900), obliquity 0.013° (2100), planet pole angles 0.01° | 0.0003°, < 0.0001°, < 0.0003° | `earthTilt(t)`: true obliquity of date from `Rotation_EQD_ECT`, plumbed as `tiltAt` |
| The Sun spun about the ecliptic pole, with its prime meridian measured from scene +X | Sun pole 7.04° off, sub-Earth longitude 166° | 0.0000°, 0.005° | `sunOrientation(t)`: the IAU pole and meridian, like the Moon and planets. Invisible today (the surface is procedural noise; the corona only uses the position). |

### Deliberate, not errors

- **Distances are compressed.** The Earth rides a circle of exactly 1 AU
  (`Sun distance` row: ±0.0167 AU, the orbit's eccentricity), and planet
  distances pass through `sceneDistance`. Undoing that mapping gives the true
  heliocentric distance to ≤ 0.001 AU (Neptune; 4 × 10⁻⁵ relative).
- **Planets seen from the Earth in the orbital view** (`geocentric λ as drawn`
  rows) point up to 7° away from their true geocentric direction, because the
  compressed distances bend the Earth–planet line. Heliocentric directions are
  exact; the planets aren't drawn from the surface view.
- **UT1 = UTC.** GAST and the sub-solar longitude are 0.0015° (0.36 s) off at
  J2000, which is UT1 − UTC on that day.
- **The Moon's distance** is within 50 km (0.013 %) — astronomy-engine's
  truncated lunar theory.

### How the comparison avoids circularity

Positions come from scene objects, never by re-calling the astronomy-engine
function under test. Horizons supplies apparent (light-time corrected)
quantities, so each body is evaluated one light time back. Horizons reports
heliocentric planet directions in the J2000 ecliptic (Sun-centred "of date"
columns are ICRF too — on the first run that showed up as a spurious 1.4°/century
drift), so the test precesses them with an independent IAU 1976 ecliptic
precession and nutation (Meeus ch. 21–22); the obliquity reference is IAU 2006
plus nutation. Horizons' sub-points are planetodetic and, for most planets,
west-positive; they are converted to the scene's planetocentric, east-positive
texture longitudes. Pole position angles use the true sightline from Horizons
(the scene's compressed distances would bend it) and the scene Earth's pole as
celestial north.

The older suite (`src/ephemeris.accuracy.test.ts`, 32–40 epochs 1950–2100)
improved the same way: sub-solar latitude 0.011° → 0.0011° (the rest is the
fixture site's solar parallax), View-from-Earth alt/az 0.011° → 0.006°.

## Results

Angles in degrees; Δ = scene − Horizons, wrapped to ±180°.

<!-- orbit-accuracy:tables:start -->
### Worst case per quantity

| Body | Quantity | max \|Δ\| | RMS Δ | Unit | Worst epoch |
|---|---|---:|---:|---|---|
| earth | Sun geocentric λ | 0.0005 | 0.0003 | ° | 2026 lunar node |
| earth | Sun distance | 0.016736 | 0.013663 | AU | 1900 |
| earth | sub-solar latitude | 0.0003 | 0.0001 | ° | J2000 |
| earth | sub-solar longitude | 0.0012 | 0.0006 | ° | J2000 |
| earth | GAST | 0.0015 | 0.0005 | ° | J2000 |
| earth | obliquity of date | 0.0000 | 0.0000 | ° | 2050 |
| moon | geocentric λ | 0.0006 | 0.0003 | ° | 2026 Mar equinox |
| moon | geocentric β | 0.0003 | 0.0001 | ° | 2100 |
| moon | distance | 49.9 | 30.3 | km | 2026-10-20 |
| moon | sub-Earth longitude | 0.0068 | 0.0045 | ° | 2026 perihelion |
| moon | sub-Earth latitude | 0.0019 | 0.0011 | ° | 2026 Sep equinox |
| moon | pole position angle | 0.0016 | 0.0010 | ° | 2026 perihelion |
| sun | sub-Earth longitude | 0.0054 | 0.0053 | ° | 2026 Mar equinox |
| sun | sub-Earth latitude | 0.0007 | 0.0006 | ° | 2026 Dec solstice |
| sun | pole position angle | 0.0000 | 0.0000 | ° | 1950 |
| mercury | heliocentric λ | 0.0029 | 0.0018 | ° | 2026-10-20 |
| mercury | heliocentric β | 0.0014 | 0.0008 | ° | 2026-10-20 |
| mercury | heliocentric r | 0.000014 | 0.000007 | AU | 2100 |
| mercury | sub-solar longitude | 0.0028 | 0.0018 | ° | 2026-10-20 |
| mercury | sub-solar latitude | 0.0013 | 0.0009 | ° | 2050 |
| mercury | sub-Earth longitude | 0.0058 | 0.0055 | ° | 2026 Dec solstice |
| mercury | sub-Earth latitude | 0.0008 | 0.0005 | ° | 2026-10-20 |
| mercury | pole position angle | 0.0000 | 0.0000 | ° | 1900 |
| mercury | geocentric λ as drawn | 2.4544 | 1.4510 | ° | 2026 Mar equinox |
| venus | heliocentric λ | 0.0019 | 0.0011 | ° | 2026 Dec solstice |
| venus | heliocentric β | 0.0007 | 0.0004 | ° | 2050 |
| venus | heliocentric r | 0.000008 | 0.000004 | AU | 2026 Sep equinox |
| venus | sub-solar longitude | 0.0020 | 0.0012 | ° | 2026 Dec solstice |
| venus | sub-solar latitude | 0.0007 | 0.0004 | ° | 2050 |
| venus | sub-Earth longitude | 0.0058 | 0.0049 | ° | 2026 perihelion |
| venus | sub-Earth latitude | 0.0004 | 0.0002 | ° | 2026 Sep equinox |
| venus | pole position angle | 0.0001 | 0.0000 | ° | 2050 |
| venus | geocentric λ as drawn | 3.3710 | 1.5606 | ° | 2026 Dec solstice |
| mars | heliocentric λ | 0.0007 | 0.0003 | ° | J2000 |
| mars | heliocentric β | 0.0010 | 0.0005 | ° | 2026 Jun solstice |
| mars | heliocentric r | 0.000018 | 0.000009 | AU | 2026 Mar equinox |
| mars | sub-solar longitude | 0.0032 | 0.0010 | ° | 1900 |
| mars | sub-solar latitude | 0.0010 | 0.0005 | ° | 2026 Jun solstice |
| mars | sub-Earth longitude | 0.0061 | 0.0034 | ° | 2026 Mar equinox |
| mars | sub-Earth latitude | 0.0025 | 0.0013 | ° | 1900 |
| mars | pole position angle | 0.0000 | 0.0000 | ° | 2026 Sep equinox |
| mars | geocentric λ as drawn | 3.8656 | 1.7153 | ° | 2050 |
| jupiter | heliocentric λ | 0.0009 | 0.0006 | ° | 1950 |
| jupiter | heliocentric β | 0.0017 | 0.0007 | ° | J2000 |
| jupiter | heliocentric r | 0.000200 | 0.000114 | AU | 1950 |
| jupiter | sub-solar longitude | 0.0112 | 0.0038 | ° | 1900 |
| jupiter | sub-solar latitude | 0.0016 | 0.0007 | ° | J2000 |
| jupiter | sub-Earth longitude | 0.0082 | 0.0041 | ° | 2026 perihelion |
| jupiter | sub-Earth latitude | 0.0002 | 0.0001 | ° | 2026 Sep equinox |
| jupiter | pole position angle | 0.0000 | 0.0000 | ° | 2026 Jun solstice |
| jupiter | geocentric λ as drawn | 5.2710 | 3.8736 | ° | 2026 Mar equinox |
| saturn | heliocentric λ | 0.0027 | 0.0021 | ° | 2026 Dec solstice |
| saturn | heliocentric β | 0.0054 | 0.0021 | ° | 1950 |
| saturn | heliocentric r | 0.000212 | 0.000124 | AU | J2000 |
| saturn | sub-solar longitude | 0.0072 | 0.0025 | ° | 1900 |
| saturn | sub-solar latitude | 0.0045 | 0.0020 | ° | 1950 |
| saturn | sub-Earth longitude | 0.0070 | 0.0045 | ° | 2026 lunar node |
| saturn | sub-Earth latitude | 0.0026 | 0.0016 | ° | 2026 Mar equinox |
| saturn | pole position angle | 0.0001 | 0.0000 | ° | 1900 |
| saturn | geocentric λ as drawn | 6.7496 | 4.5428 | ° | 2026 Dec solstice |
| uranus | heliocentric λ | 0.0032 | 0.0010 | ° | J2000 |
| uranus | heliocentric β | 0.0047 | 0.0019 | ° | 1950 |
| uranus | heliocentric r | 0.000466 | 0.000220 | AU | 1900 |
| uranus | sub-solar longitude | 0.0120 | 0.0053 | ° | 1950 |
| uranus | sub-solar latitude | 0.0029 | 0.0013 | ° | J2000 |
| uranus | sub-Earth longitude | 0.0287 | 0.0098 | ° | 1900 |
| uranus | sub-Earth latitude | 0.0051 | 0.0036 | ° | 1950 |
| uranus | pole position angle | 0.0003 | 0.0001 | ° | 1900 |
| uranus | geocentric λ as drawn | 7.1802 | 5.0674 | ° | 2100 |
| neptune | heliocentric λ | 0.0041 | 0.0029 | ° | 2100 |
| neptune | heliocentric β | 0.0026 | 0.0021 | ° | 2026 perihelion |
| neptune | heliocentric r | 0.001076 | 0.000626 | AU | 2100 |
| neptune | sub-solar longitude | 0.0057 | 0.0043 | ° | 1900 |
| neptune | sub-solar latitude | 0.0026 | 0.0014 | ° | J2000 |
| neptune | sub-Earth longitude | 0.0110 | 0.0050 | ° | 1900 |
| neptune | sub-Earth latitude | 0.0022 | 0.0014 | ° | 1900 |
| neptune | pole position angle | 0.0001 | 0.0000 | ° | J2000 |
| neptune | geocentric λ as drawn | 7.0365 | 4.8126 | ° | 2026 Dec solstice |

### Earth

<details><summary>Every epoch</summary>

| Epoch | Quantity | Expected | Actual | Δ | Unit |
|---|---|---:|---:|---:|---|
| 1900 | Sun geocentric λ | 280.6632 | 280.6633 | 0.0000 | ° |
| 1900 | Sun distance | 0.983264 | 1.000000 | 0.016736 | AU |
| 1900 | sub-solar latitude | -23.0231 | -23.0231 | -0.0001 | ° |
| 1900 | sub-solar longitude | 0.9173 | 0.9173 | -0.0000 | ° |
| 1900 | GAST | 280.6811 | 280.6811 | 0.0001 | ° |
| 1900 | obliquity of date | 23.4517 | 23.4517 | 0.0000 | ° |
| 1950 | Sun geocentric λ | 98.5971 | 98.5971 | 0.0001 | ° |
| 1950 | Sun distance | 1.016666 | 1.000000 | -0.016666 | AU |
| 1950 | sub-solar latitude | 23.1691 | 23.1691 | 0.0000 | ° |
| 1950 | sub-solar longitude | 180.8799 | 180.8800 | 0.0001 | ° |
| 1950 | GAST | 278.4779 | 278.4779 | -0.0000 | ° |
| 1950 | obliquity of date | 23.4481 | 23.4481 | -0.0000 | ° |
| J2000 | Sun geocentric λ | 280.3689 | 280.3686 | -0.0003 | ° |
| J2000 | Sun distance | 0.983328 | 1.000000 | 0.016672 | AU |
| J2000 | sub-solar latitude | -23.0324 | -23.0327 | -0.0003 | ° |
| J2000 | sub-solar longitude | 0.8198 | 0.8211 | 0.0012 | ° |
| J2000 | GAST | 280.4585 | 280.4570 | -0.0015 | ° |
| J2000 | obliquity of date | 23.4377 | 23.4377 | 0.0000 | ° |
| 2026 perihelion | Sun geocentric λ | 283.3152 | 283.3152 | -0.0000 | ° |
| 2026 perihelion | Sun distance | 0.983302 | 1.000000 | 0.016698 | AU |
| 2026 perihelion | sub-solar latitude | -22.7719 | -22.7721 | -0.0002 | ° |
| 2026 perihelion | sub-solar longitude | 290.6446 | 290.6449 | 0.0003 | ° |
| 2026 perihelion | GAST | 353.8198 | 353.8195 | -0.0003 | ° |
| 2026 perihelion | obliquity of date | 23.4381 | 23.4381 | 0.0000 | ° |
| 2026 Mar equinox | Sun geocentric λ | 0.0000 | 0.0002 | 0.0002 | ° |
| 2026 Mar equinox | Sun distance | 0.995918 | 1.000000 | 0.004082 | AU |
| 2026 Mar equinox | sub-solar latitude | 0.0001 | 0.0001 | -0.0000 | ° |
| 2026 Mar equinox | sub-solar longitude | 320.3504 | 320.3508 | 0.0004 | ° |
| 2026 Mar equinox | GAST | 39.6496 | 39.6494 | -0.0002 | ° |
| 2026 Mar equinox | obliquity of date | 23.4384 | 23.4384 | 0.0000 | ° |
| 2026 Jun solstice | Sun geocentric λ | 90.0003 | 89.9999 | -0.0004 | ° |
| 2026 Jun solstice | Sun distance | 1.016194 | 1.000000 | -0.016194 | AU |
| 2026 Jun solstice | sub-solar latitude | 23.4379 | 23.4380 | 0.0000 | ° |
| 2026 Jun solstice | sub-solar longitude | 54.1961 | 54.1957 | -0.0004 | ° |
| 2026 Jun solstice | GAST | 35.8042 | 35.8042 | -0.0000 | ° |
| 2026 Jun solstice | obliquity of date | 23.4380 | 23.4380 | -0.0000 | ° |
| 2026 Sep equinox | Sun geocentric λ | 180.0005 | 180.0002 | -0.0003 | ° |
| 2026 Sep equinox | Sun distance | 1.003577 | 1.000000 | -0.003577 | AU |
| 2026 Sep equinox | sub-solar latitude | -0.0002 | -0.0001 | 0.0001 | ° |
| 2026 Sep equinox | sub-solar longitude | 176.6368 | 176.6364 | -0.0004 | ° |
| 2026 Sep equinox | GAST | 3.3637 | 3.3638 | 0.0001 | ° |
| 2026 Sep equinox | obliquity of date | 23.4381 | 23.4381 | 0.0000 | ° |
| 2026 lunar node | Sun geocentric λ | 193.8004 | 193.7999 | -0.0005 | ° |
| 2026 lunar node | Sun distance | 0.999632 | 1.000000 | 0.000368 | AU |
| 2026 lunar node | sub-solar latitude | -5.4445 | -5.4443 | 0.0002 | ° |
| 2026 lunar node | sub-solar longitude | 157.2377 | 157.2371 | -0.0006 | ° |
| 2026 lunar node | GAST | 35.4626 | 35.4627 | 0.0001 | ° |
| 2026 lunar node | obliquity of date | 23.4381 | 23.4381 | 0.0000 | ° |
| 2026-10-20 | Sun geocentric λ | 206.6182 | 206.6178 | -0.0004 | ° |
| 2026-10-20 | Sun distance | 0.995926 | 1.000000 | 0.004074 | AU |
| 2026-10-20 | sub-solar latitude | -10.2656 | -10.2655 | 0.0002 | ° |
| 2026-10-20 | sub-solar longitude | 176.2216 | 176.2211 | -0.0005 | ° |
| 2026-10-20 | GAST | 28.4718 | 28.4720 | 0.0002 | ° |
| 2026-10-20 | obliquity of date | 23.4380 | 23.4380 | 0.0000 | ° |
| 2026 Dec solstice | Sun geocentric λ | 269.9998 | 269.9997 | -0.0002 | ° |
| 2026 Dec solstice | Sun distance | 0.983731 | 1.000000 | 0.016269 | AU |
| 2026 Dec solstice | sub-solar latitude | -23.4374 | -23.4376 | -0.0002 | ° |
| 2026 Dec solstice | sub-solar longitude | 227.0622 | 227.0615 | -0.0007 | ° |
| 2026 Dec solstice | GAST | 42.9376 | 42.9381 | 0.0005 | ° |
| 2026 Dec solstice | obliquity of date | 23.4376 | 23.4376 | 0.0000 | ° |
| 2050 | Sun geocentric λ | 99.3987 | 99.3986 | -0.0001 | ° |
| 2050 | Sun distance | 1.016586 | 1.000000 | -0.016586 | AU |
| 2050 | sub-solar latitude | 23.0980 | 23.0979 | -0.0001 | ° |
| 2050 | sub-solar longitude | 180.9755 | 180.9749 | -0.0006 | ° |
| 2050 | GAST | 279.2507 | 279.2513 | 0.0005 | ° |
| 2050 | obliquity of date | 23.4309 | 23.4309 | -0.0000 | ° |
| 2100 | Sun geocentric λ | 281.1137 | 281.1135 | -0.0002 | ° |
| 2100 | Sun distance | 0.983351 | 1.000000 | 0.016649 | AU |
| 2100 | sub-solar latitude | -22.9638 | -22.9639 | -0.0001 | ° |
| 2100 | sub-solar longitude | 0.8527 | 0.8520 | -0.0007 | ° |
| 2100 | GAST | 281.2313 | 281.2318 | 0.0005 | ° |
| 2100 | obliquity of date | 23.4286 | 23.4287 | 0.0000 | ° |

</details>

### Moon

<details><summary>Every epoch</summary>

| Epoch | Quantity | Expected | Actual | Δ | Unit |
|---|---|---:|---:|---:|---|
| 1900 | geocentric λ | 279.6163 | 279.6168 | 0.0005 | ° |
| 1900 | geocentric β | 1.7443 | 1.7443 | 0.0000 | ° |
| 1900 | distance | 366592.4 | 366584.9 | -7.5 | km |
| 1900 | sub-Earth longitude | 355.9624 | 355.9569 | -0.0055 | ° |
| 1900 | sub-Earth latitude | -2.2490 | -2.2492 | -0.0002 | ° |
| 1900 | pole position angle | 357.3407 | 357.3411 | 0.0004 | ° |
| 1950 | geocentric λ | 294.4615 | 294.4613 | -0.0002 | ° |
| 1950 | geocentric β | -4.6373 | -4.6373 | 0.0000 | ° |
| 1950 | distance | 369199.2 | 369200.9 | 1.7 | km |
| 1950 | sub-Earth longitude | 5.2029 | 5.2089 | 0.0060 | ° |
| 1950 | sub-Earth latitude | 6.0477 | 6.0476 | -0.0001 | ° |
| 1950 | pole position angle | 350.0453 | 350.0454 | 0.0001 | ° |
| J2000 | geocentric λ | 223.3238 | 223.3238 | -0.0000 | ° |
| J2000 | geocentric β | 5.1707 | 5.1708 | 0.0000 | ° |
| J2000 | distance | 402416.7 | 402440.0 | 23.3 | km |
| J2000 | sub-Earth longitude | 5.0258 | 5.0213 | -0.0045 | ° |
| J2000 | sub-Earth latitude | -6.7207 | -6.7218 | -0.0011 | ° |
| J2000 | pole position angle | 16.8913 | 16.8928 | 0.0015 | ° |
| 2026 perihelion | geocentric λ | 107.1478 | 107.1474 | -0.0003 | ° |
| 2026 perihelion | geocentric β | 4.0769 | 4.0769 | -0.0000 | ° |
| 2026 perihelion | distance | 363087.7 | 363078.2 | -9.6 | km |
| 2026 perihelion | sub-Earth longitude | 3.7158 | 3.7226 | 0.0068 | ° |
| 2026 perihelion | sub-Earth latitude | -5.3110 | -5.3094 | 0.0016 | ° |
| 2026 perihelion | pole position angle | 6.6332 | 6.6316 | -0.0016 | ° |
| 2026 Mar equinox | geocentric λ | 20.5158 | 20.5152 | -0.0006 | ° |
| 2026 Mar equinox | geocentric β | 3.4834 | 3.4834 | -0.0000 | ° |
| 2026 Mar equinox | distance | 368768.2 | 368742.8 | -25.3 | km |
| 2026 Mar equinox | sub-Earth longitude | 356.5707 | 356.5649 | -0.0058 | ° |
| 2026 Mar equinox | sub-Earth latitude | -4.4931 | -4.4917 | 0.0013 | ° |
| 2026 Mar equinox | pole position angle | 338.8173 | 338.8179 | 0.0006 | ° |
| 2026 Jun solstice | geocentric λ | 173.2803 | 173.2797 | -0.0006 | ° |
| 2026 Jun solstice | geocentric β | -1.8574 | -1.8575 | -0.0001 | ° |
| 2026 Jun solstice | distance | 385230.4 | 385181.3 | -49.1 | km |
| 2026 Jun solstice | sub-Earth longitude | 7.4608 | 7.4573 | -0.0035 | ° |
| 2026 Jun solstice | sub-Earth latitude | 2.4185 | 2.4185 | 0.0000 | ° |
| 2026 Jun solstice | pole position angle | 21.8339 | 21.8328 | -0.0011 | ° |
| 2026 Sep equinox | geocentric λ | 315.7280 | 315.7278 | -0.0001 | ° |
| 2026 Sep equinox | geocentric β | -1.2545 | -1.2544 | 0.0001 | ° |
| 2026 Sep equinox | distance | 395497.1 | 395459.2 | -37.9 | km |
| 2026 Sep equinox | sub-Earth longitude | 356.0009 | 356.0028 | 0.0019 | ° |
| 2026 Sep equinox | sub-Earth latitude | 1.6165 | 1.6184 | 0.0019 | ° |
| 2026 Sep equinox | pole position angle | 344.1563 | 344.1563 | 0.0000 | ° |
| 2026 lunar node | geocentric λ | 149.1092 | 149.1090 | -0.0002 | ° |
| 2026 lunar node | geocentric β | 0.0003 | 0.0002 | -0.0001 | ° |
| 2026 lunar node | distance | 376019.1 | 376035.2 | 16.1 | km |
| 2026 lunar node | sub-Earth longitude | 4.2213 | 4.2164 | -0.0049 | ° |
| 2026 lunar node | sub-Earth latitude | 0.0702 | 0.0697 | -0.0004 | ° |
| 2026 lunar node | pole position angle | 18.8814 | 18.8807 | -0.0007 | ° |
| 2026-10-20 | geocentric λ | 311.1979 | 311.1976 | -0.0003 | ° |
| 2026-10-20 | geocentric β | -1.4832 | -1.4831 | 0.0002 | ° |
| 2026-10-20 | distance | 398814.5 | 398764.6 | -49.9 | km |
| 2026-10-20 | sub-Earth longitude | 355.7731 | 355.7735 | 0.0003 | ° |
| 2026-10-20 | sub-Earth latitude | 1.9256 | 1.9268 | 0.0012 | ° |
| 2026-10-20 | pole position angle | 345.4253 | 345.4246 | -0.0007 | ° |
| 2026 Dec solstice | geocentric λ | 58.9979 | 58.9976 | -0.0003 | ° |
| 2026 Dec solstice | geocentric β | 5.0703 | 5.0703 | -0.0000 | ° |
| 2026 Dec solstice | distance | 362637.2 | 362607.6 | -29.6 | km |
| 2026 Dec solstice | sub-Earth longitude | 355.1434 | 355.1478 | 0.0044 | ° |
| 2026 Dec solstice | sub-Earth latitude | -6.5854 | -6.5847 | 0.0007 | ° |
| 2026 Dec solstice | pole position angle | 346.8157 | 346.8141 | -0.0016 | ° |
| 2050 | geocentric λ | 230.8122 | 230.8121 | -0.0002 | ° |
| 2050 | geocentric β | 0.0848 | 0.0849 | 0.0001 | ° |
| 2050 | distance | 385640.5 | 385600.9 | -39.7 | km |
| 2050 | sub-Earth longitude | 353.6011 | 353.6049 | 0.0038 | ° |
| 2050 | sub-Earth latitude | -0.1165 | -0.1173 | -0.0008 | ° |
| 2050 | pole position angle | 16.8461 | 16.8454 | -0.0007 | ° |
| 2100 | geocentric λ | 164.4238 | 164.4236 | -0.0001 | ° |
| 2100 | geocentric β | 0.4783 | 0.4780 | -0.0003 | ° |
| 2100 | distance | 371154.3 | 371179.9 | 25.6 | km |
| 2100 | sub-Earth longitude | 358.2358 | 358.2364 | 0.0005 | ° |
| 2100 | sub-Earth latitude | -0.6687 | -0.6672 | 0.0016 | ° |
| 2100 | pole position angle | 21.1647 | 21.1653 | 0.0006 | ° |

</details>

### Sun

<details><summary>Every epoch</summary>

| Epoch | Quantity | Expected | Actual | Δ | Unit |
|---|---|---:|---:|---:|---|
| 1900 | sub-Earth longitude | 34.1447 | 34.1394 | -0.0053 | ° |
| 1900 | sub-Earth latitude | -3.1932 | -3.1926 | 0.0007 | ° |
| 1900 | pole position angle | 1.9229 | 1.9229 | 0.0000 | ° |
| 1950 | sub-Earth longitude | 335.5924 | 335.5872 | -0.0052 | ° |
| 1950 | sub-Earth latitude | 2.8822 | 2.8816 | -0.0006 | ° |
| 1950 | pole position angle | 357.0533 | 357.0533 | 0.0000 | ° |
| J2000 | sub-Earth longitude | 1.4332 | 1.4278 | -0.0054 | ° |
| J2000 | sub-Earth latitude | -3.0138 | -3.0131 | 0.0007 | ° |
| J2000 | pole position angle | 2.1377 | 2.1377 | -0.0000 | ° |
| 2026 perihelion | sub-Earth longitude | 263.6033 | 263.5979 | -0.0054 | ° |
| 2026 perihelion | sub-Earth latitude | -3.3100 | -3.3094 | 0.0006 | ° |
| 2026 perihelion | pole position angle | 0.7550 | 0.7550 | 0.0000 | ° |
| 2026 Mar equinox | sub-Earth longitude | 343.7088 | 343.7033 | -0.0054 | ° |
| 2026 Mar equinox | sub-Earth latitude | -7.0389 | -7.0391 | -0.0002 | ° |
| 2026 Mar equinox | pole position angle | 334.8115 | 334.8115 | -0.0000 | ° |
| 2026 Jun solstice | sub-Earth longitude | 198.0958 | 198.0906 | -0.0052 | ° |
| 2026 Jun solstice | sub-Earth latitude | 1.7373 | 1.7366 | -0.0007 | ° |
| 2026 Jun solstice | pole position angle | 352.9578 | 352.9578 | -0.0000 | ° |
| 2026 Sep equinox | sub-Earth longitude | 39.8873 | 39.8820 | -0.0053 | ° |
| 2026 Sep equinox | sub-Earth latitude | 7.0391 | 7.0393 | 0.0002 | ° |
| 2026 Sep equinox | pole position angle | 25.1874 | 25.1874 | 0.0000 | ° |
| 2026 lunar node | sub-Earth longitude | 214.4680 | 214.4627 | -0.0053 | ° |
| 2026 lunar node | sub-Earth latitude | 6.4179 | 6.4182 | 0.0003 | ° |
| 2026 lunar node | pole position angle | 26.2155 | 26.2155 | -0.0000 | ° |
| 2026-10-20 | sub-Earth longitude | 43.7036 | 43.6983 | -0.0054 | ° |
| 2026-10-20 | sub-Earth latitude | 5.5078 | 5.5082 | 0.0005 | ° |
| 2026-10-20 | pole position angle | 25.9101 | 25.9101 | -0.0000 | ° |
| 2026 Dec solstice | sub-Earth longitude | 295.0016 | 294.9962 | -0.0054 | ° |
| 2026 Dec solstice | sub-Earth latitude | -1.7365 | -1.7358 | 0.0007 | ° |
| 2026 Dec solstice | pole position angle | 7.0427 | 7.0427 | -0.0000 | ° |
| 2050 | sub-Earth longitude | 289.7787 | 289.7735 | -0.0052 | ° |
| 2050 | sub-Earth latitude | 2.8251 | 2.8245 | -0.0006 | ° |
| 2050 | pole position angle | 357.3653 | 357.3653 | 0.0000 | ° |
| 2100 | sub-Earth longitude | 315.5671 | 315.5618 | -0.0053 | ° |
| 2100 | sub-Earth latitude | -2.9504 | -2.9498 | 0.0007 | ° |
| 2100 | pole position angle | 1.8552 | 1.8552 | -0.0000 | ° |

</details>

### Mercury

<details><summary>Every epoch</summary>

| Epoch | Quantity | Expected | Actual | Δ | Unit |
|---|---|---:|---:|---:|---|
| 1900 | heliocentric λ | 203.0397 | 203.0408 | 0.0011 | ° |
| 1900 | heliocentric β | 2.8727 | 2.8721 | -0.0006 | ° |
| 1900 | heliocentric r | 0.423052 | 0.423061 | 0.000009 | AU |
| 1900 | sub-solar longitude | 327.7185 | 327.7196 | 0.0011 | ° |
| 1900 | sub-solar latitude | 0.0023 | 0.0027 | 0.0005 | ° |
| 1900 | sub-Earth longitude | 24.1905 | 24.1851 | -0.0054 | ° |
| 1900 | sub-Earth latitude | -4.8329 | -4.8323 | 0.0006 | ° |
| 1900 | pole position angle | 10.3716 | 10.3716 | 0.0000 | ° |
| 1900 | geocentric λ as drawn | 259.6393 | 261.3945 | 1.7552 | ° |
| 1950 | heliocentric λ | 45.0343 | 45.0367 | 0.0024 | ° |
| 1950 | heliocentric β | -0.3327 | -0.3320 | 0.0006 | ° |
| 1950 | heliocentric r | 0.315522 | 0.315515 | -0.000007 | AU |
| 1950 | sub-solar longitude | 359.7077 | 359.7101 | 0.0024 | ° |
| 1950 | sub-solar latitude | 0.0102 | 0.0098 | -0.0003 | ° |
| 1950 | sub-Earth longitude | 41.1722 | 41.1667 | -0.0055 | ° |
| 1950 | sub-Earth latitude | 4.5108 | 4.5103 | -0.0005 | ° |
| 1950 | pole position angle | 353.0909 | 353.0909 | -0.0000 | ° |
| 1950 | geocentric λ as drawn | 86.6916 | 87.6370 | 0.9454 | ° |
| J2000 | heliocentric λ | 253.7586 | 253.7584 | -0.0002 | ° |
| J2000 | heliocentric β | -3.0205 | -3.0207 | -0.0002 | ° |
| J2000 | heliocentric r | 0.466469 | 0.466476 | 0.000007 | AU |
| J2000 | sub-solar longitude | 94.4450 | 94.4449 | -0.0002 | ° |
| J2000 | sub-solar latitude | -0.0243 | -0.0241 | 0.0002 | ° |
| J2000 | sub-Earth longitude | 112.3061 | 112.3004 | -0.0057 | ° |
| J2000 | sub-Earth latitude | -3.8612 | -3.8607 | 0.0005 | ° |
| J2000 | pole position angle | 4.2714 | 4.2714 | -0.0000 | ° |
| J2000 | geocentric λ as drawn | 271.8893 | 272.4337 | 0.5444 | ° |
| 2026 perihelion | heliocentric λ | 250.0657 | 250.0630 | -0.0027 | ° |
| 2026 perihelion | heliocentric β | -2.5700 | -2.5705 | -0.0005 | ° |
| 2026 perihelion | heliocentric r | 0.465629 | 0.465631 | 0.000002 | AU |
| 2026 perihelion | sub-solar longitude | 99.4522 | 99.4496 | -0.0026 | ° |
| 2026 perihelion | sub-solar latitude | -0.0227 | -0.0219 | 0.0008 | ° |
| 2026 perihelion | sub-Earth longitude | 121.9091 | 121.9034 | -0.0057 | ° |
| 2026 perihelion | sub-Earth latitude | -4.0504 | -4.0499 | 0.0005 | ° |
| 2026 perihelion | pole position angle | 3.8334 | 3.8334 | -0.0000 | ° |
| 2026 perihelion | geocentric λ as drawn | 272.7854 | 273.4678 | 0.6824 | ° |
| 2026 Mar equinox | heliocentric λ | 215.2599 | 215.2581 | -0.0019 | ° |
| 2026 Mar equinox | heliocentric β | 1.6292 | 1.6287 | -0.0005 | ° |
| 2026 Mar equinox | heliocentric r | 0.436725 | 0.436734 | 0.000009 | AU |
| 2026 Mar equinox | sub-solar longitude | 318.3486 | 318.3468 | -0.0018 | ° |
| 2026 Mar equinox | sub-solar latitude | -0.0039 | -0.0032 | 0.0007 | ° |
| 2026 Mar equinox | sub-Earth longitude | 81.8722 | 81.8667 | -0.0054 | ° |
| 2026 Mar equinox | sub-Earth latitude | -7.6474 | -7.6476 | -0.0002 | ° |
| 2026 Mar equinox | pole position angle | 335.6704 | 335.6704 | -0.0000 | ° |
| 2026 Mar equinox | geocentric λ as drawn | 338.4927 | 340.9471 | 2.4544 | ° |
| 2026 Jun solstice | heliocentric λ | 229.5946 | 229.5945 | -0.0001 | ° |
| 2026 Jun solstice | heliocentric β | -0.1164 | -0.1155 | 0.0009 | ° |
| 2026 Jun solstice | heliocentric r | 0.452722 | 0.452720 | -0.000002 | AU |
| 2026 Jun solstice | sub-solar longitude | 123.5291 | 123.5289 | -0.0002 | ° |
| 2026 Jun solstice | sub-solar latitude | -0.0122 | -0.0131 | -0.0009 | ° |
| 2026 Jun solstice | sub-Earth longitude | 7.3780 | 7.3729 | -0.0051 | ° |
| 2026 Jun solstice | sub-Earth latitude | 6.4504 | 6.4501 | -0.0003 | ° |
| 2026 Jun solstice | pole position angle | 6.8646 | 6.8646 | 0.0000 | ° |
| 2026 Jun solstice | geocentric λ as drawn | 113.6094 | 111.6886 | -1.9208 | ° |
| 2026 Sep equinox | heliocentric λ | 245.6631 | 245.6615 | -0.0016 | ° |
| 2026 Sep equinox | heliocentric β | -2.0591 | -2.0598 | -0.0008 | ° |
| 2026 Sep equinox | heliocentric r | 0.464035 | 0.464035 | -0.000000 | AU |
| 2026 Sep equinox | sub-solar longitude | 284.8270 | 284.8256 | -0.0015 | ° |
| 2026 Sep equinox | sub-solar latitude | -0.0206 | -0.0197 | 0.0009 | ° |
| 2026 Sep equinox | sub-Earth longitude | 238.8064 | 238.8010 | -0.0054 | ° |
| 2026 Sep equinox | sub-Earth latitude | 4.1625 | 4.1631 | 0.0006 | ° |
| 2026 Sep equinox | pole position angle | 28.4339 | 28.4339 | 0.0000 | ° |
| 2026 Sep equinox | geocentric λ as drawn | 199.4765 | 198.3947 | -1.0818 | ° |
| 2026 lunar node | heliocentric λ | 284.8563 | 284.8543 | -0.0021 | ° |
| 2026 lunar node | heliocentric β | -5.8308 | -5.8312 | -0.0005 | ° |
| 2026 lunar node | heliocentric r | 0.453730 | 0.453725 | -0.000005 | AU |
| 2026 lunar node | sub-solar longitude | 237.8563 | 237.8544 | -0.0019 | ° |
| 2026 lunar node | sub-solar latitude | -0.0331 | -0.0325 | 0.0006 | ° |
| 2026 lunar node | sub-Earth longitude | 171.4659 | 171.4608 | -0.0052 | ° |
| 2026 lunar node | sub-Earth latitude | 3.6573 | 3.6581 | 0.0007 | ° |
| 2026 lunar node | pole position angle | 25.9494 | 25.9494 | 0.0000 | ° |
| 2026 lunar node | geocentric λ as drawn | 218.2778 | 216.5955 | -1.6824 | ° |
| 2026-10-20 | heliocentric λ | 327.3659 | 327.3631 | -0.0029 | ° |
| 2026-10-20 | heliocentric β | -6.9254 | -6.9268 | -0.0014 | ° |
| 2026-10-20 | heliocentric r | 0.399605 | 0.399602 | -0.000003 | AU |
| 2026-10-20 | sub-solar longitude | 200.6397 | 200.6369 | -0.0028 | ° |
| 2026-10-20 | sub-solar latitude | -0.0298 | -0.0285 | 0.0013 | ° |
| 2026-10-20 | sub-Earth longitude | 103.6116 | 103.6063 | -0.0052 | ° |
| 2026-10-20 | sub-Earth latitude | 3.0075 | 3.0083 | 0.0008 | ° |
| 2026-10-20 | pole position angle | 22.9567 | 22.9567 | -0.0000 | ° |
| 2026-10-20 | geocentric λ as drawn | 229.8797 | 227.5048 | -2.3749 | ° |
| 2026 Dec solstice | heliocentric λ | 250.8923 | 250.8898 | -0.0025 | ° |
| 2026 Dec solstice | heliocentric β | -2.6627 | -2.6631 | -0.0004 | ° |
| 2026 Dec solstice | heliocentric r | 0.465842 | 0.465847 | 0.000005 | AU |
| 2026 Dec solstice | sub-solar longitude | 98.4567 | 98.4543 | -0.0024 | ° |
| 2026 Dec solstice | sub-solar latitude | -0.0230 | -0.0223 | 0.0007 | ° |
| 2026 Dec solstice | sub-Earth longitude | 111.2116 | 111.2058 | -0.0058 | ° |
| 2026 Dec solstice | sub-Earth latitude | -3.2020 | -3.2014 | 0.0006 | ° |
| 2026 Dec solstice | pole position angle | 8.4050 | 8.4050 | -0.0000 | ° |
| 2026 Dec solstice | geocentric λ as drawn | 263.8899 | 264.2795 | 0.3896 | ° |
| 2050 | heliocentric λ | 151.5295 | 151.5283 | -0.0012 | ° |
| 2050 | heliocentric β | 6.8389 | 6.8376 | -0.0013 | ° |
| 2050 | heliocentric r | 0.349922 | 0.349928 | 0.000006 | AU |
| 2050 | sub-solar longitude | 175.6358 | 175.6346 | -0.0011 | ° |
| 2050 | sub-solar latitude | 0.0287 | 0.0300 | 0.0013 | ° |
| 2050 | sub-Earth longitude | 136.1101 | 136.1046 | -0.0055 | ° |
| 2050 | sub-Earth latitude | 4.3841 | 4.3838 | -0.0003 | ° |
| 2050 | pole position angle | 6.1524 | 6.1524 | 0.0000 | ° |
| 2050 | geocentric λ as drawn | 111.9693 | 111.1103 | -0.8590 | ° |
| 2100 | heliocentric λ | 306.8066 | 306.8062 | -0.0003 | ° |
| 2100 | heliocentric β | -6.8367 | -6.8355 | 0.0013 | ° |
| 2100 | heliocentric r | 0.430030 | 0.430044 | 0.000014 | AU |
| 2100 | sub-solar longitude | 216.9509 | 216.9506 | -0.0003 | ° |
| 2100 | sub-solar latitude | -0.0337 | -0.0350 | -0.0013 | ° |
| 2100 | sub-Earth longitude | 198.8357 | 198.8300 | -0.0057 | ° |
| 2100 | sub-Earth latitude | -3.9354 | -3.9350 | 0.0004 | ° |
| 2100 | pole position angle | 355.5017 | 355.5017 | 0.0000 | ° |
| 2100 | geocentric λ as drawn | 288.8176 | 288.2840 | -0.5336 | ° |

</details>

### Venus

<details><summary>Every epoch</summary>

| Epoch | Quantity | Expected | Actual | Δ | Unit |
|---|---|---:|---:|---:|---|
| 1900 | heliocentric λ | 343.9184 | 343.9181 | -0.0003 | ° |
| 1900 | heliocentric β | -3.3920 | -3.3915 | 0.0005 | ° |
| 1900 | heliocentric r | 0.727397 | 0.727400 | 0.000003 | AU |
| 1900 | sub-solar longitude | 257.1044 | 257.1039 | -0.0004 | ° |
| 1900 | sub-solar latitude | 2.5157 | 2.5153 | -0.0005 | ° |
| 1900 | sub-Earth longitude | 220.1630 | 220.1578 | -0.0053 | ° |
| 1900 | sub-Earth latitude | 1.5186 | 1.5188 | 0.0002 | ° |
| 1900 | pole position angle | 346.4549 | 346.4549 | -0.0000 | ° |
| 1900 | geocentric λ as drawn | 306.9961 | 306.1745 | -0.8216 | ° |
| 1950 | heliocentric λ | 11.7092 | 11.7081 | -0.0010 | ° |
| 1950 | heliocentric β | -3.0647 | -3.0648 | -0.0001 | ° |
| 1950 | heliocentric r | 0.725685 | 0.725686 | 0.000001 | AU |
| 1950 | sub-solar longitude | 244.3088 | 244.3077 | -0.0011 | ° |
| 1950 | sub-solar latitude | 1.8828 | 1.8829 | 0.0001 | ° |
| 1950 | sub-Earth longitude | 296.7398 | 296.7352 | -0.0046 | ° |
| 1950 | sub-Earth latitude | 0.7111 | 0.7110 | -0.0001 | ° |
| 1950 | pole position angle | 348.7159 | 348.7159 | -0.0000 | ° |
| 1950 | geocentric λ as drawn | 64.1771 | 64.5803 | 0.4032 | ° |
| J2000 | heliocentric λ | 182.5896 | 182.5897 | 0.0001 | ° |
| J2000 | heliocentric β | 3.2648 | 3.2645 | -0.0003 | ° |
| J2000 | heliocentric r | 0.720212 | 0.720213 | 0.000000 | AU |
| J2000 | sub-solar longitude | 199.8814 | 199.8815 | 0.0001 | ° |
| J2000 | sub-solar latitude | -2.1664 | -2.1662 | 0.0003 | ° |
| J2000 | sub-Earth longitude | 258.8102 | 258.8057 | -0.0045 | ° |
| J2000 | sub-Earth latitude | -1.0087 | -1.0085 | 0.0002 | ° |
| J2000 | pole position angle | 12.1618 | 12.1618 | -0.0000 | ° |
| J2000 | geocentric λ as drawn | 241.5658 | 243.0968 | 1.5310 | ° |
| 2026 perihelion | heliocentric λ | 281.6354 | 281.6365 | 0.0011 | ° |
| 2026 perihelion | heliocentric β | -1.4211 | -1.4217 | -0.0006 | ° |
| 2026 perihelion | heliocentric r | 0.727566 | 0.727567 | 0.000001 | AU |
| 2026 perihelion | sub-solar longitude | 330.3817 | 330.3829 | 0.0011 | ° |
| 2026 perihelion | sub-solar latitude | 1.8194 | 1.8200 | 0.0006 | ° |
| 2026 perihelion | sub-Earth longitude | 331.3164 | 331.3106 | -0.0058 | ° |
| 2026 perihelion | sub-Earth latitude | 0.9827 | 0.9828 | 0.0001 | ° |
| 2026 perihelion | pole position angle | 355.7516 | 355.7516 | 0.0000 | ° |
| 2026 perihelion | geocentric λ as drawn | 282.5985 | 282.6278 | 0.0293 | ° |
| 2026 Mar equinox | heliocentric λ | 42.1872 | 42.1887 | 0.0016 | ° |
| 2026 Mar equinox | heliocentric β | -1.9357 | -1.9361 | -0.0005 | ° |
| 2026 Mar equinox | heliocentric r | 0.723276 | 0.723277 | 0.000002 | AU |
| 2026 Mar equinox | sub-solar longitude | 203.3554 | 203.3570 | 0.0015 | ° |
| 2026 Mar equinox | sub-solar latitude | 0.7242 | 0.7247 | 0.0005 | ° |
| 2026 Mar equinox | sub-Earth longitude | 178.7499 | 178.7445 | -0.0055 | ° |
| 2026 Mar equinox | sub-Earth latitude | -0.3350 | -0.3350 | 0.0001 | ° |
| 2026 Mar equinox | pole position angle | 337.8586 | 337.8586 | 0.0000 | ° |
| 2026 Mar equinox | geocentric λ as drawn | 17.5848 | 17.2033 | -0.3815 | ° |
| 2026 Jun solstice | heliocentric λ | 192.2138 | 192.2142 | 0.0004 | ° |
| 2026 Jun solstice | heliocentric β | 3.0701 | 3.0702 | 0.0001 | ° |
| 2026 Jun solstice | heliocentric r | 0.720874 | 0.720874 | 0.000000 | AU |
| 2026 Jun solstice | sub-solar longitude | 130.7716 | 130.7720 | 0.0004 | ° |
| 2026 Jun solstice | sub-solar latitude | -1.8949 | -1.8950 | -0.0001 | ° |
| 2026 Jun solstice | sub-Earth longitude | 67.7372 | 67.7329 | -0.0043 | ° |
| 2026 Jun solstice | sub-Earth latitude | -1.7962 | -1.7964 | -0.0002 | ° |
| 2026 Jun solstice | pole position angle | 14.2675 | 14.2675 | -0.0000 | ° |
| 2026 Jun solstice | geocentric λ as drawn | 129.1585 | 128.6137 | -0.5448 | ° |
| 2026 Sep equinox | heliocentric λ | 341.1665 | 341.1679 | 0.0014 | ° |
| 2026 Sep equinox | heliocentric β | -3.3778 | -3.3772 | 0.0005 | ° |
| 2026 Sep equinox | heliocentric r | 0.727599 | 0.727591 | -0.000008 | AU |
| 2026 Sep equinox | sub-solar longitude | 58.4809 | 58.4823 | 0.0014 | ° |
| 2026 Sep equinox | sub-solar latitude | 2.5701 | 2.5696 | -0.0005 | ° |
| 2026 Sep equinox | sub-Earth longitude | 293.8647 | 293.8601 | -0.0046 | ° |
| 2026 Sep equinox | sub-Earth latitude | 7.4449 | 7.4452 | 0.0004 | ° |
| 2026 Sep equinox | pole position angle | 19.9508 | 19.9508 | 0.0000 | ° |
| 2026 Sep equinox | geocentric λ as drawn | 216.5726 | 214.2061 | -2.3665 | ° |
| 2026 lunar node | heliocentric λ | 3.4876 | 3.4891 | 0.0015 | ° |
| 2026 lunar node | heliocentric β | -3.2543 | -3.2541 | 0.0002 | ° |
| 2026 lunar node | heliocentric r | 0.726361 | 0.726354 | -0.000007 | AU |
| 2026 lunar node | sub-solar longitude | 101.5929 | 101.5944 | 0.0015 | ° |
| 2026 lunar node | sub-solar latitude | 2.1515 | 2.1513 | -0.0002 | ° |
| 2026 lunar node | sub-Earth longitude | 316.3299 | 316.3247 | -0.0053 | ° |
| 2026 lunar node | sub-Earth latitude | 8.7001 | 8.7004 | 0.0003 | ° |
| 2026 lunar node | pole position angle | 19.7688 | 19.7688 | 0.0000 | ° |
| 2026 lunar node | geocentric λ as drawn | 218.2147 | 215.9349 | -2.2798 | ° |
| 2026-10-20 | heliocentric λ | 24.1189 | 24.1204 | 0.0015 | ° |
| 2026-10-20 | heliocentric β | -2.7054 | -2.7058 | -0.0004 | ° |
| 2026-10-20 | heliocentric r | 0.724809 | 0.724803 | -0.000005 | AU |
| 2026-10-20 | sub-solar longitude | 141.3784 | 141.3800 | 0.0016 | ° |
| 2026-10-20 | sub-solar latitude | 1.4761 | 1.4765 | 0.0004 | ° |
| 2026-10-20 | sub-Earth longitude | 330.5157 | 330.5099 | -0.0058 | ° |
| 2026-10-20 | sub-Earth latitude | 8.3411 | 8.3412 | 0.0001 | ° |
| 2026-10-20 | pole position angle | 20.6955 | 20.6955 | 0.0000 | ° |
| 2026-10-20 | geocentric λ as drawn | 213.2391 | 212.4337 | -0.8054 | ° |
| 2026 Dec solstice | heliocentric λ | 125.3913 | 125.3933 | 0.0019 | ° |
| 2026 Dec solstice | heliocentric β | 2.5427 | 2.5429 | 0.0002 | ° |
| 2026 Dec solstice | heliocentric r | 0.718491 | 0.718488 | -0.000003 | AU |
| 2026 Dec solstice | sub-solar longitude | 335.8302 | 335.8322 | 0.0020 | ° |
| 2026 Dec solstice | sub-solar latitude | -2.4352 | -2.4354 | -0.0002 | ° |
| 2026 Dec solstice | sub-Earth longitude | 74.1769 | 74.1729 | -0.0040 | ° |
| 2026 Dec solstice | sub-Earth latitude | -1.9652 | -1.9649 | 0.0002 | ° |
| 2026 Dec solstice | pole position angle | 17.4189 | 17.4189 | -0.0000 | ° |
| 2026 Dec solstice | geocentric λ as drawn | 223.7978 | 227.1688 | 3.3710 | ° |
| 2050 | heliocentric λ | 212.3899 | 212.3895 | -0.0004 | ° |
| 2050 | heliocentric β | 2.3916 | 2.3922 | 0.0007 | ° |
| 2050 | heliocentric r | 0.722464 | 0.722461 | -0.000003 | AU |
| 2050 | sub-solar longitude | 190.5644 | 190.5641 | -0.0003 | ° |
| 2050 | sub-solar latitude | -1.1568 | -1.1575 | -0.0007 | ° |
| 2050 | sub-Earth longitude | 119.7343 | 119.7302 | -0.0042 | ° |
| 2050 | sub-Earth latitude | -1.3025 | -1.3026 | -0.0002 | ° |
| 2050 | pole position angle | 17.7400 | 17.7399 | -0.0001 | ° |
| 2050 | geocentric λ as drawn | 141.5286 | 140.8995 | -0.6290 | ° |
| 2100 | heliocentric λ | 20.5212 | 20.5220 | 0.0008 | ° |
| 2100 | heliocentric β | -2.8507 | -2.8512 | -0.0005 | ° |
| 2100 | heliocentric r | 0.725150 | 0.725148 | -0.000002 | AU |
| 2100 | sub-solar longitude | 143.3877 | 143.3886 | 0.0009 | ° |
| 2100 | sub-solar latitude | 1.6400 | 1.6405 | 0.0005 | ° |
| 2100 | sub-Earth longitude | 83.5599 | 83.5555 | -0.0044 | ° |
| 2100 | sub-Earth latitude | 1.4279 | 1.4281 | 0.0002 | ° |
| 2100 | pole position angle | 342.4671 | 342.4671 | 0.0000 | ° |
| 2100 | geocentric λ as drawn | 320.6717 | 319.1245 | -1.5472 | ° |

</details>

### Mars

<details><summary>Every epoch</summary>

| Epoch | Quantity | Expected | Actual | Δ | Unit |
|---|---|---:|---:|---:|---|
| 1900 | heliocentric λ | 286.7429 | 286.7428 | -0.0001 | ° |
| 1900 | heliocentric β | -1.5685 | -1.5683 | 0.0001 | ° |
| 1900 | heliocentric r | 1.420925 | 1.420924 | -0.000001 | AU |
| 1900 | sub-solar longitude | 229.2785 | 229.2817 | 0.0032 | ° |
| 1900 | sub-solar latitude | -9.5259 | -9.5260 | -0.0001 | ° |
| 1900 | sub-Earth longitude | 228.7030 | 228.7010 | -0.0020 | ° |
| 1900 | sub-Earth latitude | -9.0712 | -9.0687 | 0.0025 | ° |
| 1900 | pole position angle | 18.7299 | 18.7299 | 0.0000 | ° |
| 1900 | geocentric λ as drawn | 284.2530 | 284.2881 | 0.0351 | ° |
| 1950 | heliocentric λ | 228.9887 | 228.9888 | 0.0001 | ° |
| 1950 | heliocentric β | 0.0060 | 0.0064 | 0.0004 | ° |
| 1950 | heliocentric r | 1.550752 | 1.550756 | 0.000003 | AU |
| 1950 | sub-solar longitude | 210.2479 | 210.2472 | -0.0006 | ° |
| 1950 | sub-solar latitude | 14.2994 | 14.2990 | -0.0004 | ° |
| 1950 | sub-Earth longitude | 167.4073 | 167.4067 | -0.0005 | ° |
| 1950 | sub-Earth latitude | 25.6374 | 25.6374 | 0.0000 | ° |
| 1950 | pole position angle | 30.9973 | 30.9973 | 0.0000 | ° |
| 1950 | geocentric λ as drawn | 188.0264 | 190.9193 | 2.8929 | ° |
| J2000 | heliocentric λ | 359.4372 | 359.4379 | 0.0007 | ° |
| J2000 | heliocentric β | -1.4198 | -1.4200 | -0.0002 | ° |
| J2000 | heliocentric r | 1.391203 | 1.391196 | -0.000006 | AU |
| J2000 | sub-solar longitude | 324.0038 | 324.0046 | 0.0008 | ° |
| J2000 | sub-solar latitude | -25.1130 | -25.1128 | 0.0003 | ° |
| J2000 | sub-Earth longitude | 290.4565 | 290.4524 | -0.0041 | ° |
| J2000 | sub-Earth latitude | -23.0149 | -23.0140 | 0.0009 | ° |
| J2000 | pole position angle | 351.6251 | 351.6251 | -0.0000 | ° |
| J2000 | geocentric λ as drawn | 327.9633 | 328.3335 | 0.3702 | ° |
| 2026 perihelion | heliocentric λ | 285.7564 | 285.7566 | 0.0002 | ° |
| 2026 perihelion | heliocentric β | -1.5333 | -1.5333 | 0.0000 | ° |
| 2026 perihelion | heliocentric r | 1.425948 | 1.425947 | -0.000001 | AU |
| 2026 perihelion | sub-solar longitude | 296.1457 | 296.1459 | 0.0002 | ° |
| 2026 perihelion | sub-solar latitude | -8.5360 | -8.5362 | -0.0001 | ° |
| 2026 perihelion | sub-Earth longitude | 296.9555 | 296.9503 | -0.0052 | ° |
| 2026 perihelion | sub-Earth latitude | -8.6831 | -8.6807 | 0.0024 | ° |
| 2026 perihelion | pole position angle | 18.6836 | 18.6836 | 0.0000 | ° |
| 2026 perihelion | geocentric λ as drawn | 284.7565 | 284.7759 | 0.0194 | ° |
| 2026 Mar equinox | heliocentric λ | 332.8613 | 332.8611 | -0.0001 | ° |
| 2026 Mar equinox | heliocentric β | -1.8014 | -1.8015 | -0.0001 | ° |
| 2026 Mar equinox | heliocentric r | 1.381493 | 1.381511 | 0.000018 | AU |
| 2026 Mar equinox | sub-solar longitude | 343.3172 | 343.3171 | -0.0001 | ° |
| 2026 Mar equinox | sub-solar latitude | -23.1576 | -23.1575 | 0.0001 | ° |
| 2026 Mar equinox | sub-Earth longitude | 357.4328 | 357.4267 | -0.0061 | ° |
| 2026 Mar equinox | sub-Earth latitude | -25.2900 | -25.2896 | 0.0004 | ° |
| 2026 Mar equinox | pole position angle | 341.7834 | 341.7834 | 0.0000 | ° |
| 2026 Mar equinox | geocentric λ as drawn | 344.1891 | 344.0080 | -0.1812 | ° |
| 2026 Jun solstice | heliocentric λ | 30.3995 | 30.3994 | -0.0000 | ° |
| 2026 Jun solstice | heliocentric β | -0.6135 | -0.6145 | -0.0010 | ° |
| 2026 Jun solstice | heliocentric r | 1.431548 | 1.431555 | 0.000007 | AU |
| 2026 Jun solstice | sub-solar longitude | 265.6670 | 265.6667 | -0.0003 | ° |
| 2026 Jun solstice | sub-solar latitude | -20.4035 | -20.4025 | 0.0010 | ° |
| 2026 Jun solstice | sub-Earth longitude | 290.8362 | 290.8320 | -0.0042 | ° |
| 2026 Jun solstice | sub-Earth latitude | -12.0389 | -12.0407 | -0.0019 | ° |
| 2026 Jun solstice | pole position angle | 322.1399 | 322.1399 | -0.0000 | ° |
| 2026 Jun solstice | geocentric λ as drawn | 54.6476 | 53.8392 | -0.8084 | ° |
| 2026 Sep equinox | heliocentric λ | 81.6725 | 81.6725 | 0.0000 | ° |
| 2026 Sep equinox | heliocentric β | 0.9777 | 0.9770 | -0.0007 | ° |
| 2026 Sep equinox | heliocentric r | 1.548268 | 1.548278 | 0.000009 | AU |
| 2026 Sep equinox | sub-solar longitude | 212.5572 | 212.5570 | -0.0002 | ° |
| 2026 Sep equinox | sub-solar latitude | -1.5699 | -1.5693 | 0.0006 | ° |
| 2026 Sep equinox | sub-Earth longitude | 245.0244 | 245.0220 | -0.0024 | ° |
| 2026 Sep equinox | sub-Earth latitude | 13.6516 | 13.6507 | -0.0009 | ° |
| 2026 Sep equinox | pole position angle | 348.5611 | 348.5611 | -0.0000 | ° |
| 2026 Sep equinox | geocentric λ as drawn | 116.9671 | 115.5774 | -1.3897 | ° |
| 2026 lunar node | heliocentric λ | 88.6925 | 88.6925 | 0.0001 | ° |
| 2026 lunar node | heliocentric β | 1.1622 | 1.1616 | -0.0006 | ° |
| 2026 lunar node | heliocentric r | 1.565659 | 1.565667 | 0.000007 | AU |
| 2026 lunar node | sub-solar longitude | 328.6705 | 328.6703 | -0.0001 | ° |
| 2026 lunar node | sub-solar latitude | 1.4172 | 1.4178 | 0.0006 | ° |
| 2026 lunar node | sub-Earth longitude | 2.5553 | 2.5534 | -0.0019 | ° |
| 2026 lunar node | sub-Earth latitude | 16.4442 | 16.4436 | -0.0006 | ° |
| 2026 lunar node | pole position angle | 353.7181 | 353.7181 | 0.0000 | ° |
| 2026 lunar node | geocentric λ as drawn | 125.1799 | 123.7409 | -1.4390 | ° |
| 2026-10-20 | heliocentric λ | 95.0272 | 95.0273 | 0.0001 | ° |
| 2026-10-20 | heliocentric β | 1.3139 | 1.3134 | -0.0005 | ° |
| 2026-10-20 | heliocentric r | 1.580944 | 1.580950 | 0.000006 | AU |
| 2026-10-20 | sub-solar longitude | 112.1021 | 112.1021 | -0.0001 | ° |
| 2026-10-20 | sub-solar latitude | 4.0984 | 4.0989 | 0.0005 | ° |
| 2026-10-20 | sub-Earth longitude | 147.2063 | 147.2048 | -0.0015 | ° |
| 2026-10-20 | sub-Earth latitude | 18.5877 | 18.5874 | -0.0003 | ° |
| 2026-10-20 | pole position angle | 358.3267 | 358.3267 | 0.0000 | ° |
| 2026-10-20 | geocentric λ as drawn | 132.3622 | 130.8858 | -1.4764 | ° |
| 2026 Dec solstice | heliocentric λ | 124.3225 | 124.3227 | 0.0002 | ° |
| 2026 Dec solstice | heliocentric β | 1.7827 | 1.7829 | 0.0002 | ° |
| 2026 Dec solstice | heliocentric r | 1.640074 | 1.640078 | 0.000004 | AU |
| 2026 Dec solstice | sub-solar longitude | 39.7468 | 39.7472 | 0.0003 | ° |
| 2026 Dec solstice | sub-solar latitude | 15.5219 | 15.5218 | -0.0001 | ° |
| 2026 Dec solstice | sub-Earth longitude | 73.5252 | 73.5275 | 0.0023 | ° |
| 2026 Dec solstice | sub-Earth latitude | 22.8243 | 22.8248 | 0.0005 | ° |
| 2026 Dec solstice | pole position angle | 14.8377 | 14.8377 | -0.0000 | ° |
| 2026 Dec solstice | geocentric λ as drawn | 158.1779 | 156.4926 | -1.6853 | ° |
| 2050 | heliocentric λ | 294.2343 | 294.2336 | -0.0006 | ° |
| 2050 | heliocentric β | -1.6662 | -1.6665 | -0.0003 | ° |
| 2050 | heliocentric r | 1.413165 | 1.413151 | -0.000015 | AU |
| 2050 | sub-solar longitude | 299.1119 | 299.1115 | -0.0004 | ° |
| 2050 | sub-solar latitude | -11.7523 | -11.7518 | 0.0005 | ° |
| 2050 | sub-Earth longitude | 328.9154 | 328.9193 | 0.0040 | ° |
| 2050 | sub-Earth latitude | -18.8193 | -18.8205 | -0.0012 | ° |
| 2050 | pole position angle | 352.8479 | 352.8479 | 0.0000 | ° |
| 2050 | geocentric λ as drawn | 325.4257 | 321.5602 | -3.8656 | ° |
| 2100 | heliocentric λ | 67.8382 | 67.8382 | 0.0000 | ° |
| 2100 | heliocentric β | 0.5566 | 0.5557 | -0.0009 | ° |
| 2100 | heliocentric r | 1.510072 | 1.510078 | 0.000006 | AU |
| 2100 | sub-solar longitude | 62.8839 | 62.8837 | -0.0002 | ° |
| 2100 | sub-solar latitude | -7.7266 | -7.7258 | 0.0008 | ° |
| 2100 | sub-Earth longitude | 24.9935 | 24.9956 | 0.0020 | ° |
| 2100 | sub-Earth latitude | -22.3545 | -22.3541 | 0.0005 | ° |
| 2100 | pole position angle | 322.8461 | 322.8461 | -0.0000 | ° |
| 2100 | geocentric λ as drawn | 29.7293 | 31.1948 | 1.4654 | ° |

</details>

### Jupiter

<details><summary>Every epoch</summary>

| Epoch | Quantity | Expected | Actual | Δ | Unit |
|---|---|---:|---:|---:|---|
| 1900 | heliocentric λ | 234.5771 | 234.5778 | 0.0007 | ° |
| 1900 | heliocentric β | 0.9238 | 0.9226 | -0.0012 | ° |
| 1900 | heliocentric r | 5.384788 | 5.384893 | 0.000105 | AU |
| 1900 | sub-solar longitude | 56.7203 | 56.7315 | 0.0112 | ° |
| 1900 | sub-solar latitude | -3.0806 | -3.0794 | 0.0012 | ° |
| 1900 | sub-Earth longitude | 67.0254 | 67.0314 | 0.0060 | ° |
| 1900 | sub-Earth latitude | -3.0091 | -3.0091 | 0.0001 | ° |
| 1900 | pole position angle | 11.9307 | 11.9307 | 0.0000 | ° |
| 1900 | geocentric λ as drawn | 241.2335 | 243.9917 | 2.7582 | ° |
| 1950 | heliocentric λ | 327.4450 | 327.4440 | -0.0009 | ° |
| 1950 | heliocentric β | -0.9632 | -0.9638 | -0.0006 | ° |
| 1950 | heliocentric r | 5.020408 | 5.020208 | -0.000200 | AU |
| 1950 | sub-solar longitude | 206.5525 | 206.5526 | 0.0001 | ° |
| 1950 | sub-solar latitude | 0.5912 | 0.5918 | 0.0006 | ° |
| 1950 | sub-Earth longitude | 213.4909 | 213.4949 | 0.0040 | ° |
| 1950 | sub-Earth latitude | 1.1055 | 1.1055 | 0.0000 | ° |
| 1950 | pole position angle | 335.8960 | 335.8960 | 0.0000 | ° |
| 1950 | geocentric λ as drawn | 337.4265 | 342.0929 | 4.6664 | ° |
| J2000 | heliocentric λ | 36.2883 | 36.2890 | 0.0007 | ° |
| J2000 | heliocentric β | -1.1746 | -1.1729 | 0.0017 | ° |
| J2000 | heliocentric r | 4.965378 | 4.965485 | 0.000108 | AU |
| J2000 | sub-solar longitude | 317.3835 | 317.3867 | 0.0031 | ° |
| J2000 | sub-solar latitude | 3.0631 | 3.0614 | -0.0016 | ° |
| J2000 | sub-Earth longitude | 304.6049 | 304.6088 | 0.0039 | ° |
| J2000 | sub-Earth latitude | 2.8935 | 2.8937 | 0.0002 | ° |
| J2000 | pole position angle | 337.1642 | 337.1642 | -0.0000 | ° |
| J2000 | geocentric λ as drawn | 25.2531 | 20.0337 | -5.2194 | ° |
| 2026 perihelion | heliocentric λ | 109.5531 | 109.5525 | -0.0007 | ° |
| 2026 perihelion | heliocentric β | 0.1996 | 0.1993 | -0.0003 | ° |
| 2026 perihelion | heliocentric r | 5.212863 | 5.212960 | 0.000097 | AU |
| 2026 perihelion | sub-solar longitude | 199.5878 | 199.5896 | 0.0018 | ° |
| 2026 perihelion | sub-solar latitude | 1.4656 | 1.4660 | 0.0004 | ° |
| 2026 perihelion | sub-Earth longitude | 196.1230 | 196.1311 | 0.0082 | ° |
| 2026 perihelion | sub-Earth latitude | 1.3821 | 1.3820 | -0.0001 | ° |
| 2026 perihelion | pole position angle | 10.3546 | 10.3546 | -0.0000 | ° |
| 2026 perihelion | geocentric λ as drawn | 111.0026 | 111.9423 | 0.9396 | ° |
| 2026 Mar equinox | heliocentric λ | 115.7979 | 115.7972 | -0.0007 | ° |
| 2026 Mar equinox | heliocentric β | 0.3385 | 0.3381 | -0.0003 | ° |
| 2026 Mar equinox | heliocentric r | 5.240246 | 5.240344 | 0.000098 | AU |
| 2026 Mar equinox | sub-solar longitude | 355.3536 | 355.3553 | 0.0017 | ° |
| 2026 Mar equinox | sub-solar latitude | 1.1577 | 1.1580 | 0.0004 | ° |
| 2026 Mar equinox | sub-Earth longitude | 343.0256 | 343.0295 | 0.0040 | ° |
| 2026 Mar equinox | sub-Earth latitude | 1.4084 | 1.4083 | -0.0001 | ° |
| 2026 Mar equinox | pole position angle | 7.8514 | 7.8514 | 0.0000 | ° |
| 2026 Mar equinox | geocentric λ as drawn | 105.2325 | 99.9615 | -5.2710 | ° |
| 2026 Jun solstice | heliocentric λ | 123.3393 | 123.3386 | -0.0007 | ° |
| 2026 Jun solstice | heliocentric β | 0.5006 | 0.5002 | -0.0004 | ° |
| 2026 Jun solstice | heliocentric r | 5.272853 | 5.272955 | 0.000102 | AU |
| 2026 Jun solstice | sub-solar longitude | 273.5294 | 273.5311 | 0.0017 | ° |
| 2026 Jun solstice | sub-solar latitude | 0.7679 | 0.7683 | 0.0004 | ° |
| 2026 Jun solstice | sub-Earth longitude | 272.7175 | 272.7150 | -0.0025 | ° |
| 2026 Jun solstice | sub-Earth latitude | 0.9991 | 0.9993 | 0.0001 | ° |
| 2026 Jun solstice | pole position angle | 13.2789 | 13.2789 | -0.0000 | ° |
| 2026 Jun solstice | geocentric λ as drawn | 118.1223 | 116.3070 | -1.8154 | ° |
| 2026 Sep equinox | heliocentric λ | 130.8641 | 130.8636 | -0.0006 | ° |
| 2026 Sep equinox | heliocentric β | 0.6537 | 0.6533 | -0.0005 | ° |
| 2026 Sep equinox | heliocentric r | 5.304337 | 5.304435 | 0.000098 | AU |
| 2026 Sep equinox | sub-solar longitude | 112.4803 | 112.4822 | 0.0019 | ° |
| 2026 Sep equinox | sub-solar latitude | 0.3658 | 0.3663 | 0.0005 | ° |
| 2026 Sep equinox | sub-Earth longitude | 123.2777 | 123.2759 | -0.0018 | ° |
| 2026 Sep equinox | sub-Earth latitude | 0.1854 | 0.1856 | 0.0002 | ° |
| 2026 Sep equinox | pole position angle | 20.0214 | 20.0214 | 0.0000 | ° |
| 2026 Sep equinox | geocentric λ as drawn | 138.1172 | 140.8807 | 2.7635 | ° |
| 2026 lunar node | heliocentric λ | 131.9854 | 131.9849 | -0.0005 | ° |
| 2026 lunar node | heliocentric β | 0.6757 | 0.6752 | -0.0005 | ° |
| 2026 lunar node | heliocentric r | 5.308904 | 5.308999 | 0.000095 | AU |
| 2026 lunar node | sub-solar longitude | 121.9872 | 121.9892 | 0.0020 | ° |
| 2026 lunar node | sub-solar latitude | 0.3052 | 0.3057 | 0.0005 | ° |
| 2026 lunar node | sub-Earth longitude | 133.3591 | 133.3582 | -0.0009 | ° |
| 2026 lunar node | sub-Earth latitude | 0.0564 | 0.0566 | 0.0002 | ° |
| 2026 lunar node | pole position angle | 20.6999 | 20.6999 | -0.0000 | ° |
| 2026 lunar node | geocentric λ as drawn | 140.6491 | 144.1144 | 3.4653 | ° |
| 2026-10-20 | heliocentric λ | 133.0168 | 133.0164 | -0.0005 | ° |
| 2026-10-20 | heliocentric β | 0.6956 | 0.6951 | -0.0005 | ° |
| 2026-10-20 | heliocentric r | 5.313071 | 5.313163 | 0.000092 | AU |
| 2026-10-20 | sub-solar longitude | 13.8282 | 13.8302 | 0.0020 | ° |
| 2026-10-20 | sub-solar latitude | 0.2493 | 0.2498 | 0.0005 | ° |
| 2026-10-20 | sub-Earth longitude | 25.3359 | 25.3358 | -0.0000 | ° |
| 2026-10-20 | sub-Earth latitude | -0.0577 | -0.0575 | 0.0002 | ° |
| 2026-10-20 | pole position angle | 21.2205 | 21.2205 | -0.0000 | ° |
| 2026-10-20 | geocentric λ as drawn | 142.7072 | 146.7929 | 4.0857 | ° |
| 2026 Dec solstice | heliocentric λ | 138.0044 | 138.0041 | -0.0003 | ° |
| 2026 Dec solstice | heliocentric β | 0.7887 | 0.7881 | -0.0006 | ° |
| 2026 Dec solstice | heliocentric r | 5.332704 | 5.332787 | 0.000083 | AU |
| 2026 Dec solstice | sub-solar longitude | 9.9987 | 10.0009 | 0.0022 | ° |
| 2026 Dec solstice | sub-solar latitude | -0.0216 | -0.0211 | 0.0006 | ° |
| 2026 Dec solstice | sub-Earth longitude | 15.8541 | 15.8597 | 0.0055 | ° |
| 2026 Dec solstice | sub-Earth latitude | -0.4527 | -0.4527 | -0.0000 | ° |
| 2026 Dec solstice | pole position angle | 22.2040 | 22.2040 | -0.0000 | ° |
| 2026 Dec solstice | geocentric λ as drawn | 146.8969 | 152.0659 | 5.1689 | ° |
| 2050 | heliocentric λ | 132.4731 | 132.4734 | 0.0003 | ° |
| 2050 | heliocentric β | 0.6792 | 0.6792 | 0.0000 | ° |
| 2050 | heliocentric r | 5.303338 | 5.303424 | 0.000086 | AU |
| 2050 | sub-solar longitude | 323.8246 | 323.8274 | 0.0027 | ° |
| 2050 | sub-solar latitude | 0.2980 | 0.2980 | -0.0001 | ° |
| 2050 | sub-Earth longitude | 323.0893 | 323.0867 | -0.0025 | ° |
| 2050 | sub-Earth latitude | 0.5694 | 0.5695 | 0.0001 | ° |
| 2050 | pole position angle | 16.6697 | 16.6697 | 0.0000 | ° |
| 2050 | geocentric λ as drawn | 127.3184 | 125.5088 | -1.8097 | ° |
| 2100 | heliocentric λ | 191.0295 | 191.0295 | -0.0000 | ° |
| 2100 | heliocentric β | 1.2988 | 1.2984 | -0.0004 | ° |
| 2100 | heliocentric r | 5.451436 | 5.451287 | -0.000150 | AU |
| 2100 | sub-solar longitude | 65.7030 | 65.7055 | 0.0025 | ° |
| 2100 | sub-solar latitude | -2.4720 | -2.4716 | 0.0004 | ° |
| 2100 | sub-Earth longitude | 76.3722 | 76.3736 | 0.0014 | ° |
| 2100 | sub-Earth latitude | -2.7696 | -2.7695 | 0.0002 | ° |
| 2100 | pole position angle | 23.5836 | 23.5836 | 0.0000 | ° |
| 2100 | geocentric λ as drawn | 201.2592 | 206.2729 | 5.0138 | ° |

</details>

### Saturn

<details><summary>Every epoch</summary>

| Epoch | Quantity | Expected | Actual | Δ | Unit |
|---|---|---:|---:|---:|---|
| 1900 | heliocentric λ | 266.5319 | 266.5300 | -0.0019 | ° |
| 1900 | heliocentric β | 1.1030 | 1.1046 | 0.0016 | ° |
| 1900 | heliocentric r | 10.066880 | 10.066964 | 0.000083 | AU |
| 1900 | sub-solar longitude | 164.0755 | 164.0827 | 0.0072 | ° |
| 1900 | sub-solar latitude | 26.6392 | 26.6378 | -0.0014 | ° |
| 1900 | sub-Earth longitude | 169.9524 | 169.9556 | 0.0031 | ° |
| 1900 | sub-Earth latitude | 26.6317 | 26.6322 | 0.0005 | ° |
| 1900 | pole position angle | 6.0061 | 6.0060 | -0.0001 | ° |
| 1900 | geocentric λ as drawn | 267.7749 | 269.0145 | 1.2396 | ° |
| 1950 | heliocentric λ | 170.0426 | 170.0421 | -0.0005 | ° |
| 1950 | heliocentric β | 2.0833 | 2.0779 | -0.0054 | ° |
| 1950 | heliocentric r | 9.405908 | 9.405803 | -0.000105 | AU |
| 1950 | sub-solar longitude | 316.8095 | 316.8071 | -0.0023 | ° |
| 1950 | sub-solar latitude | -1.2743 | -1.2699 | 0.0045 | ° |
| 1950 | sub-Earth longitude | 313.5122 | 313.5109 | -0.0013 | ° |
| 1950 | sub-Earth latitude | -3.8663 | -3.8675 | -0.0012 | ° |
| 1950 | pole position angle | 354.7319 | 354.7319 | 0.0000 | ° |
| 1950 | geocentric λ as drawn | 164.3796 | 159.0234 | -5.3562 | ° |
| J2000 | heliocentric λ | 45.7165 | 45.7171 | 0.0005 | ° |
| J2000 | heliocentric β | -2.3032 | -2.3032 | 0.0001 | ° |
| J2000 | heliocentric r | 9.183858 | 9.183647 | -0.000212 | AU |
| J2000 | sub-solar longitude | 96.9774 | 96.9798 | 0.0024 | ° |
| J2000 | sub-solar latitude | -20.7920 | -20.7922 | -0.0002 | ° |
| J2000 | sub-Earth longitude | 89.1324 | 89.1372 | 0.0049 | ° |
| J2000 | sub-Earth latitude | -19.0759 | -19.0766 | -0.0007 | ° |
| J2000 | pole position angle | 0.2170 | 0.2170 | 0.0000 | ° |
| J2000 | geocentric λ as drawn | 40.3956 | 33.9996 | -6.3961 | ° |
| 2026 perihelion | heliocentric λ | 2.0067 | 2.0043 | -0.0024 | ° |
| 2026 perihelion | heliocentric β | -2.3067 | -2.3067 | -0.0000 | ° |
| 2026 perihelion | heliocentric r | 9.517726 | 9.517905 | 0.000179 | AU |
| 2026 perihelion | sub-solar longitude | 6.7275 | 6.7273 | -0.0002 | ° |
| 2026 perihelion | sub-solar latitude | -3.6184 | -3.6173 | 0.0011 | ° |
| 2026 perihelion | sub-Earth longitude | 2.8005 | 2.8011 | 0.0005 | ° |
| 2026 perihelion | sub-Earth latitude | -1.0360 | -1.0350 | 0.0010 | ° |
| 2026 perihelion | pole position angle | 4.4272 | 4.4271 | -0.0001 | ° |
| 2026 perihelion | geocentric λ as drawn | 356.3300 | 350.3757 | -5.9544 | ° |
| 2026 Mar equinox | heliocentric λ | 4.5660 | 4.5636 | -0.0024 | ° |
| 2026 Mar equinox | heliocentric β | -2.3458 | -2.3456 | 0.0002 | ° |
| 2026 Mar equinox | heliocentric r | 9.494300 | 9.494430 | 0.000130 | AU |
| 2026 Mar equinox | sub-solar longitude | 13.8892 | 13.8889 | -0.0004 | ° |
| 2026 Mar equinox | sub-solar latitude | -4.7552 | -4.7543 | 0.0009 | ° |
| 2026 Mar equinox | sub-Earth longitude | 18.0479 | 18.0447 | -0.0032 | ° |
| 2026 Mar equinox | sub-Earth latitude | -4.7550 | -4.7523 | 0.0026 | ° |
| 2026 Mar equinox | pole position angle | 3.8424 | 3.8424 | -0.0000 | ° |
| 2026 Mar equinox | geocentric λ as drawn | 4.1274 | 3.7456 | -0.3818 | ° |
| 2026 Jun solstice | heliocentric λ | 7.7098 | 7.7073 | -0.0025 | ° |
| 2026 Jun solstice | heliocentric β | -2.3873 | -2.3869 | 0.0004 | ° |
| 2026 Jun solstice | heliocentric r | 9.465760 | 9.465827 | 0.000067 | AU |
| 2026 Jun solstice | sub-solar longitude | 67.2730 | 67.2724 | -0.0006 | ° |
| 2026 Jun solstice | sub-solar latitude | -6.1406 | -6.1399 | 0.0007 | ° |
| 2026 Jun solstice | sub-Earth longitude | 73.5498 | 73.5504 | 0.0006 | ° |
| 2026 Jun solstice | sub-Earth latitude | -8.8357 | -8.8353 | 0.0004 | ° |
| 2026 Jun solstice | pole position angle | 3.0381 | 3.0382 | 0.0001 | ° |
| 2026 Jun solstice | geocentric λ as drawn | 13.7006 | 19.6322 | 5.9316 | ° |
| 2026 Sep equinox | heliocentric λ | 10.9037 | 10.9011 | -0.0026 | ° |
| 2026 Sep equinox | heliocentric β | -2.4223 | -2.4216 | 0.0007 | ° |
| 2026 Sep equinox | heliocentric r | 9.437106 | 9.437107 | 0.000001 | AU |
| 2026 Sep equinox | sub-solar longitude | 96.3623 | 96.3615 | -0.0008 | ° |
| 2026 Sep equinox | sub-solar latitude | -7.5328 | -7.5322 | 0.0005 | ° |
| 2026 Sep equinox | sub-Earth longitude | 93.0522 | 93.0591 | 0.0069 | ° |
| 2026 Sep equinox | sub-Earth latitude | -7.8472 | -7.8497 | -0.0025 | ° |
| 2026 Sep equinox | pole position angle | 3.1529 | 3.1529 | 0.0000 | ° |
| 2026 Sep equinox | geocentric λ as drawn | 12.1965 | 13.9337 | 1.7373 | ° |
| 2026 lunar node | heliocentric λ | 11.3843 | 11.3817 | -0.0027 | ° |
| 2026 lunar node | heliocentric β | -2.4269 | -2.4261 | 0.0007 | ° |
| 2026 lunar node | heliocentric r | 9.432826 | 9.432818 | -0.000007 | AU |
| 2026 lunar node | sub-solar longitude | 224.5611 | 224.5603 | -0.0008 | ° |
| 2026 lunar node | sub-solar latitude | -7.7408 | -7.7403 | 0.0005 | ° |
| 2026 lunar node | sub-Earth longitude | 219.7579 | 219.7650 | 0.0070 | ° |
| 2026 lunar node | sub-Earth latitude | -7.3564 | -7.3589 | -0.0025 | ° |
| 2026 lunar node | pole position angle | 3.2464 | 3.2464 | -0.0000 | ° |
| 2026 lunar node | geocentric λ as drawn | 11.1027 | 10.7036 | -0.3991 | ° |
| 2026-10-20 | heliocentric λ | 11.8275 | 11.8249 | -0.0027 | ° |
| 2026-10-20 | heliocentric β | -2.4310 | -2.4302 | 0.0008 | ° |
| 2026-10-20 | heliocentric r | 9.428886 | 9.428873 | -0.000013 | AU |
| 2026-10-20 | sub-solar longitude | 169.1056 | 169.1047 | -0.0008 | ° |
| 2026-10-20 | sub-solar latitude | -7.9322 | -7.9317 | 0.0005 | ° |
| 2026-10-20 | sub-Earth longitude | 163.1856 | 163.1925 | 0.0068 | ° |
| 2026-10-20 | sub-Earth latitude | -6.9241 | -6.9264 | -0.0023 | ° |
| 2026-10-20 | pole position angle | 3.3311 | 3.3311 | -0.0000 | ° |
| 2026-10-20 | geocentric λ as drawn | 10.1104 | 7.7539 | -2.3564 | ° |
| 2026 Dec solstice | heliocentric λ | 13.9858 | 13.9831 | -0.0027 | ° |
| 2026 Dec solstice | heliocentric β | -2.4488 | -2.4479 | 0.0009 | ° |
| 2026 Dec solstice | heliocentric r | 9.409836 | 9.409792 | -0.000043 | AU |
| 2026 Dec solstice | sub-solar longitude | 317.9458 | 317.9449 | -0.0010 | ° |
| 2026 Dec solstice | sub-solar latitude | -8.8583 | -8.8580 | 0.0003 | ° |
| 2026 Dec solstice | sub-Earth longitude | 311.7127 | 311.7153 | 0.0027 | ° |
| 2026 Dec solstice | sub-Earth latitude | -6.1855 | -6.1856 | -0.0001 | ° |
| 2026 Dec solstice | pole position angle | 3.5135 | 3.5135 | 0.0000 | ° |
| 2026 Dec solstice | geocentric λ as drawn | 8.0393 | 1.2898 | -6.7496 | ° |
| 2050 | heliocentric λ | 304.7414 | 304.7404 | -0.0010 | ° |
| 2050 | heliocentric β | -0.4601 | -0.4620 | -0.0019 | ° |
| 2050 | heliocentric r | 9.958313 | 9.958520 | 0.000207 | AU |
| 2050 | sub-solar longitude | 167.9749 | 167.9766 | 0.0017 | ° |
| 2050 | sub-solar latitude | 20.0209 | 20.0230 | 0.0021 | ° |
| 2050 | sub-Earth longitude | 166.4692 | 166.4759 | 0.0067 | ° |
| 2050 | sub-Earth latitude | 19.0770 | 19.0752 | -0.0018 | ° |
| 2050 | pole position angle | 6.6121 | 6.6121 | -0.0000 | ° |
| 2050 | geocentric λ as drawn | 307.5017 | 311.2696 | 3.7679 | ° |
| 2100 | heliocentric λ | 200.0055 | 200.0043 | -0.0012 | ° |
| 2100 | heliocentric β | 2.4746 | 2.4787 | 0.0041 | ° |
| 2100 | heliocentric r | 9.666264 | 9.666413 | 0.000149 | AU |
| 2100 | sub-solar longitude | 325.6376 | 325.6401 | 0.0026 | ° |
| 2100 | sub-solar latitude | 10.9676 | 10.9634 | -0.0042 | ° |
| 2100 | sub-Earth longitude | 331.8300 | 331.8304 | 0.0005 | ° |
| 2100 | sub-Earth latitude | 13.3189 | 13.3186 | -0.0003 | ° |
| 2100 | pole position angle | 357.8136 | 357.8136 | 0.0000 | ° |
| 2100 | geocentric λ as drawn | 205.6605 | 211.7630 | 6.1026 | ° |

</details>

### Uranus

<details><summary>Every epoch</summary>

| Epoch | Quantity | Expected | Actual | Δ | Unit |
|---|---|---:|---:|---:|---|
| 1900 | heliocentric λ | 248.6663 | 248.6669 | 0.0006 | ° |
| 1900 | heliocentric β | 0.0661 | 0.0678 | 0.0017 | ° |
| 1900 | heliocentric r | 18.992871 | 18.992405 | -0.000466 | AU |
| 1900 | sub-solar longitude | 329.9607 | 329.9512 | -0.0095 | ° |
| 1900 | sub-solar latitude | -79.2279 | -79.2295 | -0.0016 | ° |
| 1900 | sub-Earth longitude | 333.8801 | 333.8514 | -0.0287 | ° |
| 1900 | sub-Earth latitude | -80.2212 | -80.2181 | 0.0031 | ° |
| 1900 | pole position angle | 46.5790 | 46.5793 | 0.0003 | ° |
| 1900 | geocentric λ as drawn | 250.1668 | 253.3039 | 3.1371 | ° |
| 1950 | heliocentric λ | 95.2415 | 95.2416 | 0.0002 | ° |
| 1950 | heliocentric β | 0.2826 | 0.2873 | 0.0047 | ° |
| 1950 | heliocentric r | 18.913492 | 18.913505 | 0.000012 | AU |
| 1950 | sub-solar longitude | 267.4331 | 267.4210 | -0.0120 | ° |
| 1950 | sub-solar latitude | 70.0852 | 70.0832 | -0.0020 | ° |
| 1950 | sub-Earth longitude | 264.7374 | 264.7311 | -0.0063 | ° |
| 1950 | sub-Earth latitude | 69.9346 | 69.9397 | 0.0051 | ° |
| 1950 | pole position angle | 68.4625 | 68.4625 | 0.0000 | ° |
| 1950 | geocentric λ as drawn | 95.4073 | 95.7450 | 0.3377 | ° |
| J2000 | heliocentric λ | 316.4134 | 316.4102 | -0.0032 | ° |
| J2000 | heliocentric β | -0.6848 | -0.6862 | -0.0014 | ° |
| J2000 | heliocentric r | 19.924015 | 19.924006 | -0.000009 | AU |
| J2000 | sub-solar longitude | 268.3900 | 268.3873 | -0.0027 | ° |
| J2000 | sub-solar latitude | -30.8052 | -30.8081 | -0.0029 | ° |
| J2000 | sub-Earth longitude | 265.7862 | 265.7847 | -0.0015 | ° |
| J2000 | sub-Earth latitude | -32.3871 | -32.3918 | -0.0047 | ° |
| J2000 | pole position angle | 262.5330 | 262.5329 | -0.0001 | ° |
| J2000 | geocentric λ as drawn | 314.8092 | 311.2954 | -3.5138 | ° |
| 2026 perihelion | heliocentric λ | 59.9341 | 59.9337 | -0.0004 | ° |
| 2026 perihelion | heliocentric β | -0.1897 | -0.1885 | 0.0013 | ° |
| 2026 perihelion | heliocentric r | 19.489676 | 19.489473 | -0.000203 | AU |
| 2026 perihelion | sub-solar longitude | 274.8314 | 274.8340 | 0.0026 | ° |
| 2026 perihelion | sub-solar latitude | 70.4695 | 70.4686 | -0.0009 | ° |
| 2026 perihelion | sub-Earth longitude | 274.6344 | 274.6378 | 0.0035 | ° |
| 2026 perihelion | sub-Earth latitude | 68.5623 | 68.5662 | 0.0038 | ° |
| 2026 perihelion | pole position angle | 278.0600 | 278.0600 | -0.0000 | ° |
| 2026 perihelion | geocentric λ as drawn | 57.8777 | 52.1152 | -5.7626 | ° |
| 2026 Mar equinox | heliocentric λ | 60.8016 | 60.8012 | -0.0003 | ° |
| 2026 Mar equinox | heliocentric β | -0.1784 | -0.1770 | 0.0014 | ° |
| 2026 Mar equinox | heliocentric r | 19.476210 | 19.476015 | -0.000195 | AU |
| 2026 Mar equinox | sub-solar longitude | 163.7545 | 163.7574 | 0.0028 | ° |
| 2026 Mar equinox | sub-solar latitude | 71.2571 | 71.2563 | -0.0009 | ° |
| 2026 Mar equinox | sub-Earth longitude | 159.4652 | 159.4616 | -0.0036 | ° |
| 2026 Mar equinox | sub-Earth latitude | 68.9560 | 68.9533 | -0.0028 | ° |
| 2026 Mar equinox | pole position angle | 278.6566 | 278.6565 | -0.0001 | ° |
| 2026 Mar equinox | geocentric λ as drawn | 58.3050 | 52.8069 | -5.4981 | ° |
| 2026 Jun solstice | heliocentric λ | 61.8630 | 61.8627 | -0.0003 | ° |
| 2026 Jun solstice | heliocentric β | -0.1644 | -0.1630 | 0.0014 | ° |
| 2026 Jun solstice | heliocentric r | 19.459622 | 19.459438 | -0.000185 | AU |
| 2026 Jun solstice | sub-solar longitude | 200.5492 | 200.5525 | 0.0033 | ° |
| 2026 Jun solstice | sub-solar latitude | 72.2112 | 72.2103 | -0.0009 | ° |
| 2026 Jun solstice | sub-Earth longitude | 199.9975 | 199.9889 | -0.0086 | ° |
| 2026 Jun solstice | sub-Earth latitude | 73.4154 | 73.4109 | -0.0044 | ° |
| 2026 Jun solstice | pole position angle | 286.4187 | 286.4187 | -0.0000 | ° |
| 2026 Jun solstice | geocentric λ as drawn | 63.2069 | 65.9463 | 2.7394 | ° |
| 2026 Sep equinox | heliocentric λ | 62.9367 | 62.9364 | -0.0003 | ° |
| 2026 Sep equinox | heliocentric β | -0.1503 | -0.1487 | 0.0015 | ° |
| 2026 Sep equinox | heliocentric r | 19.442739 | 19.442552 | -0.000187 | AU |
| 2026 Sep equinox | sub-solar longitude | 337.6154 | 337.6192 | 0.0038 | ° |
| 2026 Sep equinox | sub-solar latitude | 73.1640 | 73.1631 | -0.0009 | ° |
| 2026 Sep equinox | sub-Earth longitude | 343.7704 | 343.7750 | 0.0046 | ° |
| 2026 Sep equinox | sub-Earth latitude | 75.5151 | 75.5172 | 0.0021 | ° |
| 2026 Sep equinox | pole position angle | 291.6484 | 291.6484 | -0.0000 | ° |
| 2026 Sep equinox | geocentric λ as drawn | 65.6339 | 72.5302 | 6.8963 | ° |
| 2026 lunar node | heliocentric λ | 63.0977 | 63.0975 | -0.0003 | ° |
| 2026 lunar node | heliocentric β | -0.1481 | -0.1466 | 0.0015 | ° |
| 2026 lunar node | heliocentric r | 19.440195 | 19.440008 | -0.000188 | AU |
| 2026 lunar node | sub-solar longitude | 179.5311 | 179.5350 | 0.0039 | ° |
| 2026 lunar node | sub-solar latitude | 73.3059 | 73.3050 | -0.0009 | ° |
| 2026 lunar node | sub-Earth longitude | 185.5419 | 185.5489 | 0.0070 | ° |
| 2026 lunar node | sub-Earth latitude | 75.3234 | 75.3265 | 0.0031 | ° |
| 2026 lunar node | pole position angle | 291.1161 | 291.1161 | -0.0000 | ° |
| 2026 lunar node | geocentric λ as drawn | 65.4109 | 71.6001 | 6.1892 | ° |
| 2026-10-20 | heliocentric λ | 63.2462 | 63.2459 | -0.0003 | ° |
| 2026-10-20 | heliocentric β | -0.1462 | -0.1446 | 0.0015 | ° |
| 2026-10-20 | heliocentric r | 19.437849 | 19.437661 | -0.000189 | AU |
| 2026-10-20 | sub-solar longitude | 187.3693 | 187.3732 | 0.0039 | ° |
| 2026-10-20 | sub-solar latitude | 73.4364 | 73.4355 | -0.0009 | ° |
| 2026-10-20 | sub-Earth longitude | 192.9054 | 192.9139 | 0.0084 | ° |
| 2026-10-20 | sub-Earth latitude | 75.0351 | 75.0390 | 0.0039 | ° |
| 2026-10-20 | pole position angle | 290.3398 | 290.3398 | -0.0000 | ° |
| 2026-10-20 | geocentric λ as drawn | 65.0764 | 70.1598 | 5.0834 | ° |
| 2026 Dec solstice | heliocentric λ | 63.9683 | 63.9681 | -0.0002 | ° |
| 2026 Dec solstice | heliocentric β | -0.1366 | -0.1350 | 0.0016 | ° |
| 2026 Dec solstice | heliocentric r | 19.426417 | 19.426229 | -0.000188 | AU |
| 2026 Dec solstice | sub-solar longitude | 15.6057 | 15.6100 | 0.0042 | ° |
| 2026 Dec solstice | sub-solar latitude | 74.0661 | 74.0652 | -0.0009 | ° |
| 2026 Dec solstice | sub-Earth longitude | 15.9498 | 15.9570 | 0.0072 | ° |
| 2026 Dec solstice | sub-Earth latitude | 72.8877 | 72.8922 | 0.0045 | ° |
| 2026 Dec solstice | pole position angle | 285.3860 | 285.3859 | -0.0001 | ° |
| 2026 Dec solstice | geocentric λ as drawn | 62.6393 | 58.7716 | -3.8677 | ° |
| 2050 | heliocentric λ | 170.1797 | 170.1803 | 0.0007 | ° |
| 2050 | heliocentric β | 0.7687 | 0.7682 | -0.0005 | ° |
| 2050 | heliocentric r | 18.283111 | 18.282794 | -0.000316 | AU |
| 2050 | sub-solar longitude | 244.2686 | 244.2687 | 0.0001 | ° |
| 2050 | sub-solar latitude | -1.9103 | -1.9110 | -0.0007 | ° |
| 2050 | sub-Earth longitude | 242.8468 | 242.8460 | -0.0008 | ° |
| 2050 | sub-Earth latitude | 1.0165 | 1.0185 | 0.0021 | ° |
| 2050 | pole position angle | 105.2085 | 105.2085 | -0.0000 | ° |
| 2050 | geocentric λ as drawn | 167.2258 | 161.1693 | -6.0565 | ° |
| 2100 | heliocentric λ | 20.5467 | 20.5472 | 0.0005 | ° |
| 2100 | heliocentric β | -0.6248 | -0.6253 | -0.0006 | ° |
| 2100 | heliocentric r | 19.970625 | 19.970724 | 0.000099 | AU |
| 2100 | sub-solar longitude | 230.0976 | 230.0966 | -0.0011 | ° |
| 2100 | sub-solar latitude | 31.2808 | 31.2814 | 0.0006 | ° |
| 2100 | sub-Earth longitude | 230.0099 | 230.0095 | -0.0005 | ° |
| 2100 | sub-Earth latitude | 28.5090 | 28.5097 | 0.0007 | ° |
| 2100 | pole position angle | 256.0366 | 256.0366 | 0.0000 | ° |
| 2100 | geocentric λ as drawn | 17.7437 | 10.5635 | -7.1802 | ° |

</details>

### Neptune

<details><summary>Every epoch</summary>

| Epoch | Quantity | Expected | Actual | Δ | Unit |
|---|---|---:|---:|---:|---|
| 1900 | heliocentric λ | 85.7027 | 85.7032 | 0.0006 | ° |
| 1900 | heliocentric β | -1.2582 | -1.2591 | -0.0009 | ° |
| 1900 | heliocentric r | 29.871079 | 29.871638 | 0.000559 | AU |
| 1900 | sub-solar longitude | 311.0984 | 311.1042 | 0.0057 | ° |
| 1900 | sub-solar latitude | 18.3766 | 18.3776 | 0.0010 | ° |
| 1900 | sub-Earth longitude | 307.6286 | 307.6396 | 0.0110 | ° |
| 1900 | sub-Earth latitude | 18.2196 | 18.2218 | 0.0022 | ° |
| 1900 | pole position angle | 335.0610 | 335.0610 | 0.0000 | ° |
| 1900 | geocentric λ as drawn | 85.2051 | 82.9923 | -2.2128 | ° |
| 1950 | heliocentric λ | 196.4947 | 196.4927 | -0.0020 | ° |
| 1950 | heliocentric β | 1.6117 | 1.6126 | 0.0009 | ° |
| 1950 | heliocentric r | 30.296745 | 30.297633 | 0.000888 | AU |
| 1950 | sub-solar longitude | 18.4062 | 18.4036 | -0.0026 | ° |
| 1950 | sub-solar latitude | 12.7701 | 12.7701 | 0.0000 | ° |
| 1950 | sub-Earth longitude | 16.2307 | 16.2309 | 0.0002 | ° |
| 1950 | sub-Earth latitude | 13.5532 | 13.5528 | -0.0004 | ° |
| 1950 | pole position angle | 46.8522 | 46.8522 | 0.0000 | ° |
| 1950 | geocentric λ as drawn | 194.5820 | 187.5585 | -7.0236 | ° |
| J2000 | heliocentric λ | 303.9239 | 303.9264 | 0.0025 | ° |
| J2000 | heliocentric β | 0.2420 | 0.2443 | 0.0022 | ° |
| J2000 | heliocentric r | 30.120588 | 30.120472 | -0.000116 | AU |
| J2000 | sub-solar longitude | 301.0591 | 301.0621 | 0.0030 | ° |
| J2000 | sub-solar latitude | -27.6925 | -27.6951 | -0.0026 | ° |
| J2000 | sub-Earth longitude | 303.0744 | 303.0690 | -0.0054 | ° |
| J2000 | sub-Earth latitude | -27.5832 | -27.5824 | 0.0007 | ° |
| J2000 | pole position angle | 354.9652 | 354.9651 | -0.0001 | ° |
| J2000 | geocentric λ as drawn | 303.1930 | 300.8136 | -2.3794 | ° |
| 2026 perihelion | heliocentric λ | 1.3756 | 1.3788 | 0.0032 | ° |
| 2026 perihelion | heliocentric β | -1.3403 | -1.3377 | 0.0026 | ° |
| 2026 perihelion | heliocentric r | 29.884743 | 29.885349 | 0.000606 | AU |
| 2026 perihelion | sub-solar longitude | 49.8291 | 49.8338 | 0.0047 | ° |
| 2026 perihelion | sub-solar latitude | -19.5192 | -19.5205 | -0.0014 | ° |
| 2026 perihelion | sub-Earth longitude | 48.6814 | 48.6805 | -0.0009 | ° |
| 2026 perihelion | sub-Earth latitude | -20.1395 | -20.1398 | -0.0003 | ° |
| 2026 perihelion | pole position angle | 317.3937 | 317.3937 | 0.0000 | ° |
| 2026 perihelion | geocentric λ as drawn | 359.5424 | 352.9764 | -6.5660 | ° |
| 2026 Mar equinox | heliocentric λ | 1.8383 | 1.8416 | 0.0033 | ° |
| 2026 Mar equinox | heliocentric β | -1.3495 | -1.3469 | 0.0026 | ° |
| 2026 Mar equinox | heliocentric r | 29.882823 | 29.883423 | 0.000600 | AU |
| 2026 Mar equinox | sub-solar longitude | 7.2467 | 7.2515 | 0.0047 | ° |
| 2026 Mar equinox | sub-solar latitude | -19.3548 | -19.3562 | -0.0014 | ° |
| 2026 Mar equinox | sub-Earth longitude | 10.3138 | 10.3086 | -0.0052 | ° |
| 2026 Mar equinox | sub-Earth latitude | -19.4159 | -19.4178 | -0.0019 | ° |
| 2026 Mar equinox | pole position angle | 316.6025 | 316.6025 | 0.0000 | ° |
| 2026 Mar equinox | geocentric λ as drawn | 1.7735 | 1.5943 | -0.1792 | ° |
| 2026 Jun solstice | heliocentric λ | 2.4038 | 2.4071 | 0.0033 | ° |
| 2026 Jun solstice | heliocentric β | -1.3607 | -1.3581 | 0.0026 | ° |
| 2026 Jun solstice | heliocentric r | 29.880519 | 29.881111 | 0.000592 | AU |
| 2026 Jun solstice | sub-solar longitude | 224.9712 | 224.9759 | 0.0047 | ° |
| 2026 Jun solstice | sub-solar latitude | -19.1526 | -19.1539 | -0.0013 | ° |
| 2026 Jun solstice | sub-Earth longitude | 227.0816 | 227.0818 | 0.0001 | ° |
| 2026 Jun solstice | sub-Earth latitude | -18.4740 | -18.4742 | -0.0003 | ° |
| 2026 Jun solstice | pole position angle | 315.7829 | 315.7829 | 0.0000 | ° |
| 2026 Jun solstice | geocentric λ as drawn | 4.3473 | 11.2030 | 6.8557 | ° |
| 2026 Sep equinox | heliocentric λ | 2.9749 | 2.9781 | 0.0032 | ° |
| 2026 Sep equinox | heliocentric β | -1.3718 | -1.3692 | 0.0026 | ° |
| 2026 Sep equinox | heliocentric r | 29.878250 | 29.878829 | 0.000579 | AU |
| 2026 Sep equinox | sub-solar longitude | 305.9034 | 305.9081 | 0.0047 | ° |
| 2026 Sep equinox | sub-solar latitude | -18.9467 | -18.9480 | -0.0013 | ° |
| 2026 Sep equinox | sub-Earth longitude | 302.8569 | 302.8630 | 0.0061 | ° |
| 2026 Sep equinox | sub-Earth latitude | -18.8661 | -18.8641 | 0.0020 | ° |
| 2026 Sep equinox | pole position angle | 316.1875 | 316.1875 | -0.0000 | ° |
| 2026 Sep equinox | geocentric λ as drawn | 3.0837 | 3.5288 | 0.4451 | ° |
| 2026 lunar node | heliocentric λ | 3.0604 | 3.0636 | 0.0032 | ° |
| 2026 lunar node | heliocentric β | -1.3734 | -1.3708 | 0.0026 | ° |
| 2026 lunar node | heliocentric r | 29.877913 | 29.878492 | 0.000578 | AU |
| 2026 lunar node | sub-solar longitude | 262.5964 | 262.6011 | 0.0047 | ° |
| 2026 lunar node | sub-solar latitude | -18.9157 | -18.9170 | -0.0013 | ° |
| 2026 lunar node | sub-Earth longitude | 259.1463 | 259.1523 | 0.0061 | ° |
| 2026 lunar node | sub-Earth latitude | -19.0004 | -18.9984 | 0.0020 | ° |
| 2026 lunar node | pole position angle | 316.3133 | 316.3133 | 0.0000 | ° |
| 2026 lunar node | geocentric λ as drawn | 2.6963 | 1.1010 | -1.5953 | ° |
| 2026-10-20 | heliocentric λ | 3.1392 | 3.1424 | 0.0032 | ° |
| 2026-10-20 | heliocentric β | -1.3749 | -1.3724 | 0.0026 | ° |
| 2026-10-20 | heliocentric r | 29.877605 | 29.878182 | 0.000577 | AU |
| 2026-10-20 | sub-solar longitude | 97.5429 | 97.5476 | 0.0047 | ° |
| 2026-10-20 | sub-solar latitude | -18.8870 | -18.8883 | -0.0013 | ° |
| 2026-10-20 | sub-Earth longitude | 93.9029 | 93.9085 | 0.0056 | ° |
| 2026-10-20 | sub-Earth latitude | -19.1188 | -19.1170 | 0.0018 | ° |
| 2026-10-20 | pole position angle | 316.4243 | 316.4243 | 0.0000 | ° |
| 2026-10-20 | geocentric λ as drawn | 2.3590 | 358.9997 | -3.3593 | ° |
| 2026 Dec solstice | heliocentric λ | 3.5226 | 3.5258 | 0.0032 | ° |
| 2026 Dec solstice | heliocentric β | -1.3823 | -1.3797 | 0.0026 | ° |
| 2026 Dec solstice | heliocentric r | 29.876117 | 29.876696 | 0.000579 | AU |
| 2026 Dec solstice | sub-solar longitude | 277.5065 | 277.5111 | 0.0047 | ° |
| 2026 Dec solstice | sub-solar latitude | -18.7476 | -18.7489 | -0.0013 | ° |
| 2026 Dec solstice | sub-Earth longitude | 275.4951 | 275.4957 | 0.0006 | ° |
| 2026 Dec solstice | sub-Earth latitude | -19.3981 | -19.3979 | 0.0002 | ° |
| 2026 Dec solstice | pole position angle | 316.6651 | 316.6652 | 0.0001 | ° |
| 2026 Dec solstice | geocentric λ as drawn | 1.6360 | 354.5995 | -7.0365 | ° |
| 2050 | heliocentric λ | 56.0944 | 56.0937 | -0.0007 | ° |
| 2050 | heliocentric β | -1.7149 | -1.7151 | -0.0002 | ° |
| 2050 | heliocentric r | 29.816741 | 29.816883 | 0.000142 | AU |
| 2050 | sub-solar longitude | 180.4336 | 180.4334 | -0.0002 | ° |
| 2050 | sub-solar latitude | 4.4482 | 4.4481 | -0.0001 | ° |
| 2050 | sub-Earth longitude | 183.9430 | 183.9399 | -0.0031 | ° |
| 2050 | sub-Earth latitude | 5.0336 | 5.0316 | -0.0021 | ° |
| 2050 | pole position angle | 318.5897 | 318.5897 | -0.0000 | ° |
| 2050 | geocentric λ as drawn | 57.3981 | 61.5826 | 4.1845 | ° |
| 2100 | heliocentric λ | 165.5780 | 165.5821 | 0.0041 | ° |
| 2100 | heliocentric β | 0.9512 | 0.9520 | 0.0008 | ° |
| 2100 | heliocentric r | 30.207742 | 30.208817 | 0.001076 | AU |
| 2100 | sub-solar longitude | 115.7788 | 115.7837 | 0.0048 | ° |
| 2100 | sub-solar latitude | 24.8004 | 24.7987 | -0.0017 | ° |
| 2100 | sub-Earth longitude | 116.3207 | 116.3238 | 0.0031 | ° |
| 2100 | sub-Earth latitude | 24.4043 | 24.4038 | -0.0005 | ° |
| 2100 | pole position angle | 36.3271 | 36.3272 | 0.0001 | ° |
| 2100 | geocentric λ as drawn | 167.2869 | 174.1313 | 6.8445 | ° |

</details>
<!-- orbit-accuracy:tables:end -->
