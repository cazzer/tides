# Tides

This started as a project to simulate the tides based on celestial movement. Turns out all that is pretty complicated, so it's only gotten as far as a rough representation of the sun, the earth, and the moon.

See it here: [https://cazzer.github.io/tides/](https://cazzer.github.io/tides/)

## Resources

- Earth textures are from the [Planet Pixel Emporium](https://planetpixelemporium.com/earth8081.html)
  - referred from [reddit](https://www.reddit.com/r/blender/comments/khzosf/photorealistic_earth_21k_diffuse_texture_16k/)
- Alternative textures are available on [Visible Earth](https://visibleearth.nasa.gov/collection/1595/earth-at-night?page=5)
- Planet textures are from [Solar System Scope](https://www.solarsystemscope.com/textures/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
  - Mercury, Venus (atmosphere), Mars, Jupiter, Saturn and its ring alpha, Uranus, Neptune
- Constellation lines are from [d3-celestial](https://github.com/ofrohn/d3-celestial) (`data/constellations.lines.json`), Copyright (c) 2015, Olaf Frohn, under the [BSD 3-Clause License](https://github.com/ofrohn/d3-celestial/blob/master/LICENSE); rebuild with `scripts/convertConstellations.mjs`
- Constellation art (`src/assets/constellation-art.webp`) is by Johan Meuris for [Stellarium](https://github.com/Stellarium/stellarium/tree/master/skycultures/modern) (`skycultures/modern/illustrations`), under the [Free Art License 1.3](https://artlibre.org/licence/lal/en/); reduced to line art, resized and packed into one atlas, and that modified version stays under the same license. Its anchor data comes from the same sky culture's `index.json` under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), and the anchor star positions from d3-celestial's `data/stars.8.json`; rebuild with `scripts/convertConstellationArt.mjs`
