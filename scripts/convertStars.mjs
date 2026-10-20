import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const inputPath = path.join(root, "src", "assets", "ybsc5");
const outputBinPath = path.join(root, "src", "assets", "stars.bin");
const outputMetaPath = path.join(root, "src", "assets", "stars.meta.json");
const outputDistancePath = path.join(root, "src", "assets", "stars.distance.bin");

const args = new Set(process.argv.slice(2));
const maxMagArgIndex = process.argv.findIndex((arg) => arg === "--maxMag");
const maxMag =
  maxMagArgIndex !== -1 && process.argv[maxMagArgIndex + 1]
    ? Number(process.argv[maxMagArgIndex + 1])
    : null;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Approximate B-V to RGB conversion.
// Source: https://www.vendian.org/mncharity/dir3/starcolor/
const bvToRgb = (bv) => {
  const bvClamped = clamp(bv, -0.4, 2.0);
  let t;
  let r;
  let g;
  let b;

  if (bvClamped < 0.0) {
    t = (bvClamped + 0.4) / 0.4;
    r = 0.61 + 0.11 * t + 0.1 * t * t;
    g = 0.7 + 0.07 * t + 0.1 * t * t;
    b = 1.0;
  } else if (bvClamped < 0.4) {
    t = (bvClamped - 0.0) / 0.4;
    r = 0.83 + 0.17 * t;
    g = 0.87 + 0.11 * t;
    b = 1.0;
  } else if (bvClamped < 1.6) {
    t = (bvClamped - 0.4) / 1.2;
    r = 1.0;
    g = 0.98 - 0.16 * t;
  } else {
    t = (bvClamped - 1.6) / 0.4;
    r = 1.0;
    g = 0.82 - 0.5 * t * t;
  }

  if (bvClamped < 0.4) {
    b = 1.0;
  } else if (bvClamped < 1.5) {
    t = (bvClamped - 0.4) / 1.1;
    b = 1.0 - 0.47 * t + 0.1 * t * t;
  } else {
    t = (bvClamped - 1.5) / 0.5;
    b = 0.63 - 0.6 * t * t;
  }

  return [clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)];
};

const parseNumber = (text) => {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
};

const toRadians = (deg) => (deg * Math.PI) / 180;

// YBSC5's parallaxes are pre-Hipparcos with errors of ~0.01", so anything
// smaller than this is mostly noise.
const MIN_PARALLAX = 0.02;

// Rough absolute V magnitudes by spectral class and luminosity class, for a
// representative (not measured) distance when the parallax is missing or
// unreliable. Classes: V dwarfs, IV subgiants, III giants, II bright giants,
// I supergiants.
const ABSOLUTE_MAG = {
  V: { O: -5, B: -1.5, A: 1.5, F: 3, G: 4.5, K: 6, M: 9 },
  IV: { O: -5, B: -2, A: 1, F: 2.5, G: 3, K: 3, M: 3 },
  III: { O: -5.5, B: -2, A: 0, F: 0.8, G: 0.8, K: 0.5, M: -0.5 },
  II: { O: -6, B: -3, A: -2.5, F: -2.5, G: -2.5, K: -2.5, M: -2.5 },
  I: { O: -6.5, B: -6.5, A: -6.5, F: -6, G: -6, K: -6, M: -6 },
};
// The YBSC's typical star (a K giant or late B dwarf) when the type is no help.
const DEFAULT_ABSOLUTE_MAG = 0.5;

// "M1-2Ia-Iab" is class M, luminosity I. Without a luminosity class, hot stars
// this bright are mostly dwarfs and cool ones mostly giants.
const absoluteMagnitude = (spType) => {
  const type = /[OBAFGKM]/.exec(spType);
  if (!type) {
    return DEFAULT_ABSOLUTE_MAG;
  }
  const rest = spType.substring(type.index + 1);
  const luminosity =
    /III|II|IV|V|I/.exec(rest)?.[0] ?? ("GKM".includes(type[0]) ? "III" : "V");
  return ABSOLUTE_MAG[luminosity][type[0]];
};

// Distance in parsecs: the catalog parallax when it is big enough to trust,
// else the distance modulus from the spectral type.
const distanceParsecs = (parallax, vmag, spType) =>
  parallax !== null && parallax >= MIN_PARALLAX
    ? 1 / parallax
    : 10 ** ((vmag - absoluteMagnitude(spType) + 5) / 5);

const lines = fs.readFileSync(inputPath, "utf8").split(/\r?\n/);
const starData = [];
const distances = [];
let fromParallax = 0;
let skipped = 0;

for (const line of lines) {
  if (!line.trim()) {
    continue;
  }

  const raH = parseNumber(line.substring(75, 77));
  const raM = parseNumber(line.substring(77, 79));
  const raS = parseNumber(line.substring(79, 83));
  const decSign = line.substring(83, 84).trim() || "+";
  const decD = parseNumber(line.substring(84, 86));
  const decM = parseNumber(line.substring(86, 88));
  const decS = parseNumber(line.substring(88, 90));
  const vmag = parseNumber(line.substring(102, 107));
  const bv = parseNumber(line.substring(109, 114));
  const spType = line.substring(127, 147);
  const parallax = parseNumber(line.substring(161, 166));

  if (
    raH === null ||
    raM === null ||
    raS === null ||
    decD === null ||
    decM === null ||
    decS === null ||
    vmag === null
  ) {
    skipped += 1;
    continue;
  }

  if (maxMag !== null && vmag > maxMag) {
    continue;
  }

  const raHours = raH + raM / 60 + raS / 3600;
  const raDeg = raHours * 15;
  const decDeg = (decD + decM / 60 + decS / 3600) * (decSign === "-" ? -1 : 1);

  const raRad = toRadians(raDeg);
  const decRad = toRadians(decDeg);
  const cosDec = Math.cos(decRad);

  const x = cosDec * Math.cos(raRad);
  const y = Math.sin(decRad);
  const z = cosDec * Math.sin(raRad);

  const [r, g, b] = bv !== null ? bvToRgb(bv) : [1, 1, 1];

  starData.push(x, y, z, r, g, b, vmag);
  distances.push(distanceParsecs(parallax, vmag, spType));
  if (parallax !== null && parallax >= MIN_PARALLAX) {
    fromParallax += 1;
  }
}

const floatData = new Float32Array(starData);
const buffer = Buffer.from(floatData.buffer);

fs.writeFileSync(outputBinPath, buffer);
fs.writeFileSync(
  outputDistancePath,
  Buffer.from(new Float32Array(distances).buffer)
);
fs.writeFileSync(
  outputMetaPath,
  JSON.stringify(
    {
      count: floatData.length / 7,
      stride: 7,
      magnitudeCutoff: maxMag,
      attributes: {
        position: { offset: 0, components: 3 },
        color: { offset: 3, components: 3 },
        vmag: { offset: 6, components: 1 }
      },
      // stars.distance.bin: one float32 per star, in the same order.
      distance: {
        unit: "pc",
        fromParallax,
        minParallax: MIN_PARALLAX
      }
    },
    null,
    2
  )
);

console.log(
  `Converted ${floatData.length / 7} stars (${fromParallax} distances ` +
    `from parallax). Skipped ${skipped}. ` +
    `Output: ${path.relative(root, outputBinPath)} + ${path.relative(
      root,
      outputMetaPath
    )}`
);
