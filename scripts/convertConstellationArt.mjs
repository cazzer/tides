// Builds src/assets/constellation-art.webp (an atlas of line-art figures) and
// src/assets/constellation-art.json (each figure's tile and anchor stars) from
// Stellarium's modern sky culture, for the figures in constellations.json:
//   git clone --depth 1 https://github.com/Stellarium/stellarium
//   curl -LO https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/stars.8.json
//   node scripts/convertConstellationArt.mjs stellarium/skycultures/modern stars.8.json
// Needs ImageMagick 7 (`magick`) on the PATH.
//
// The illustrations are by Johan Meuris for Stellarium, under the Free Art
// License 1.3; the anchor data is Stellarium's, under CC BY-SA 4.0. This
// script changes the art (line strokes kept, shading dropped, resized, packed
// into an atlas); the result stays under the Free Art License and the notice
// travels in the JSON's `license` field. Star positions for the anchors are
// d3-celestial's (BSD 3-Clause, like constellations.json).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [skyculturePath, starsPath] = process.argv.slice(2);
if (!skyculturePath || !starsPath) {
  console.error(
    "usage: node scripts/convertConstellationArt.mjs <stellarium/skycultures/modern> <stars.8.json>"
  );
  process.exit(1);
}
const assets = path.join(process.cwd(), "src", "assets");
const atlasPath = path.join(assets, "constellation-art.webp");
const outputPath = path.join(assets, "constellation-art.json");

// Every tile is this square; the sources are 128-512 px.
const TILE = 256;
// Strokes are drawn ~gray 20 over a ~gray 100 fill. Pixels darker than
// STROKE_DARK count fully as line, fading out by STROKE_LIGHT, but only near
// the figure, so the black background doesn't.
const STROKE_DARK = 0.12;
const STROKE_LIGHT = 0.22;

const round = (value) => Math.round(value * 10000) / 10000;
const magick = (...args) => execFileSync("magick", args, { stdio: "inherit" });

const { figures: lineFigures } = JSON.parse(
  fs.readFileSync(path.join(assets, "constellations.json"), "utf8")
);
const index = JSON.parse(fs.readFileSync(path.join(skyculturePath, "index.json"), "utf8"));
const stars = new Map(
  JSON.parse(fs.readFileSync(starsPath, "utf8")).features.map((star) => {
    const [lon, dec] = star.geometry.coordinates;
    return [star.id, [round(lon < 0 ? lon + 360 : lon), round(dec)]];
  })
);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "constellation-art-"));
const tiles = [];
const figures = {};
for (const constellation of index.constellations) {
  const id = constellation.id.split(" ").pop();
  const image = constellation.image;
  if (!(id in lineFigures) || !image) continue;

  const [width, height] = image.size;
  // [u, v, ra, dec] per anchor: u, v from the tile's top-left, 0..1; ra, dec
  // J2000 degrees.
  const anchors = image.anchors.map(({ pos: [x, y], hip }) => {
    const star = stars.get(hip);
    if (!star) throw new Error(`${id}: anchor HIP ${hip} is not in ${starsPath}`);
    return [round(x / width), round(y / height), ...star];
  });

  // Line art: the dark strokes inside the (slightly grown) figure, plus its
  // outline. Dark shading wider than a stroke would come out as solid
  // patches, so those keep only their edges. Worked at 512 px so every source
  // gets the same stroke weights.
  const tile = path.join(work, `${id}.png`);
  const gray = path.join(work, "gray.png");
  const region = path.join(work, "region.png");
  const lines = path.join(work, "lines.png");
  const patches = path.join(work, "patches.png");
  magick(
    path.join(skyculturePath, image.file),
    "-background", "black", "-alpha", "remove", "-alpha", "off",
    "-colorspace", "gray", "-resize", "512x512!", gray
  );
  magick(gray, "-threshold", "3%", "-morphology", "Dilate", "Disk:2.5", region);
  magick(
    "(", gray,
    "-fx", `max(0,min(1,(${STROKE_LIGHT}-u)/${STROKE_LIGHT - STROKE_DARK}))`,
    region, "-compose", "multiply", "-composite", ")",
    "(", region, "-morphology", "EdgeIn", "Disk:1", ")",
    "-compose", "lighten", "-composite", lines
  );
  magick(lines, "-morphology", "Open", "Disk:3.5", patches);
  magick(
    lines, patches, "-compose", "minus_src", "-composite",
    "(", patches, "-morphology", "EdgeIn", "Disk:1", ")",
    "-compose", "lighten", "-composite",
    "-resize", `${TILE}x${TILE}!`, tile
  );

  figures[id] = { tile: tiles.length, anchors };
  tiles.push(tile);
}

const columns = Math.ceil(Math.sqrt(tiles.length));
const rows = Math.ceil(tiles.length / columns);
magick(
  "-size", `${columns * TILE}x${rows * TILE}`, "xc:black",
  ...tiles.flatMap((tile, i) => [
    tile, "-geometry", `+${(i % columns) * TILE}+${Math.floor(i / columns) * TILE}`, "-composite",
  ]),
  "-colorspace", "gray", "-quality", "82", atlasPath
);
fs.rmSync(work, { recursive: true, force: true });

const output = {
  source:
    "https://github.com/Stellarium/stellarium skycultures/modern (illustrations/, index.json); anchor star positions from https://github.com/ofrohn/d3-celestial data/stars.8.json",
  license:
    "Constellation illustrations by Johan Meuris for Stellarium, Free Art License 1.3 (https://artlibre.org/licence/lal/en/), modified: reduced to line art, resized and packed into constellation-art.webp. Anchor data from Stellarium, CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). Star positions from d3-celestial, Copyright (c) 2015, Olaf Frohn, BSD 3-Clause License.",
  atlas: { columns, rows },
  figures,
};
fs.writeFileSync(outputPath, `${JSON.stringify(output)}\n`);
console.log(
  `Wrote ${tiles.length} figures to ${atlasPath} (${columns}x${rows} tiles of ${TILE} px) and ${outputPath}`
);
