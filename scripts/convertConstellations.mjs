// Builds src/assets/constellations.json from d3-celestial's stick figures:
//   curl -LO https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json
//   node scripts/convertConstellations.mjs constellations.lines.json
//
// d3-celestial (https://github.com/ofrohn/d3-celestial) is
// Copyright (c) 2015, Olaf Frohn, BSD 3-Clause; the notice travels with the
// data in the output's `license` field.
import fs from "node:fs";
import path from "node:path";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: node scripts/convertConstellations.mjs <constellations.lines.json>");
  process.exit(1);
}
const outputPath = path.join(process.cwd(), "src", "assets", "constellations.json");

// d3-celestial ranks figures 1 (most prominent) to 3; 1 and 2 are the 46
// major ones (Orion, the Big Dipper, the zodiac, the Southern Cross, ...).
const MAX_RANK = 2;

const round = (value) => Math.round(value * 1000) / 1000;

const source = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const figures = {};
for (const feature of source.features) {
  if (Number(feature.properties.rank) > MAX_RANK) continue;
  // Each polyline flattened to [ra, dec, ra, dec, ...], J2000 degrees with
  // RA in 0..360 (d3-celestial stores it as a longitude, -180..180).
  figures[feature.id] = feature.geometry.coordinates.map((line) =>
    line.flatMap(([lon, dec]) => [round(lon < 0 ? lon + 360 : lon), round(dec)])
  );
}

const output = {
  source: "https://github.com/ofrohn/d3-celestial data/constellations.lines.json",
  license:
    "Copyright (c) 2015, Olaf Frohn. All rights reserved. BSD 3-Clause License: https://github.com/ofrohn/d3-celestial/blob/master/LICENSE",
  figures,
};
fs.writeFileSync(outputPath, `${JSON.stringify(output)}\n`);
console.log(`Wrote ${Object.keys(figures).length} constellations to ${outputPath}`);
