// The cloud map's channel select (tides-0oi.11, cloudShaders.ts field() and
// cloudColumn()) as the shader text has it, for the tests that pin the text
// from before it (cloudShaders.test.ts, nightLights.test.ts): its uniform,
// and the column's read, which asBeforeRedMap() puts back as it was.

export const RED_UNIFORM = `// 1 where the map is one channel (the static clouds, R8, tides-0oi.11), its
// grey in R alone; 0 for an RGBA map (the blend's output).
uniform float uCloudMapRed;
`

export const RED_READ =
  / {2}\/\/ Smoothed near the poles \(\.\/poleSmoothing\.ts\)\. A one-channel map is\n {2}\/\/ grey, R = G = B, as its RGBA texel was\.\n {2}vec4 raw = ([^;]*);\n {2}vec3 c = uCloudMapRed > 0\.5 \? raw\.rrr : raw\.rgb;\n/

/** The text with the select's uniform taken out and the column's read as it
 * was before it. */
export function asBeforeRedMap(text: string): string {
  return text.replace(RED_UNIFORM, '').replace(RED_READ, '  // Smoothed near the poles (./poleSmoothing.ts).\n  vec3 c = $1.rgb;\n')
}
