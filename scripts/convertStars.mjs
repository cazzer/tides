import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const inputPath = path.join(root, "src", "assets", "ybsc5");
const outputBinPath = path.join(root, "src", "assets", "stars.bin");
const outputMetaPath = path.join(root, "src", "assets", "stars.meta.json");

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

const lines = fs.readFileSync(inputPath, "utf8").split(/\r?\n/);
const starData = [];
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
}

const floatData = new Float32Array(starData);
const buffer = Buffer.from(floatData.buffer);

fs.writeFileSync(outputBinPath, buffer);
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
      }
    },
    null,
    2
  )
);

console.log(
  `Converted ${floatData.length / 7} stars. Skipped ${skipped}. ` +
    `Output: ${path.relative(root, outputBinPath)} + ${path.relative(
      root,
      outputMetaPath
    )}`
);
