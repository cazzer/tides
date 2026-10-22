import { useCallback, useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import {
  GLARE_CORE_MIN_PX,
  GLARE_DEPTH_SHARE,
  GLARE_FADE_PX,
  GLARE_HALO_MAX_PX,
  GLARE_HALO_SCALE,
  GLARE_MIN_VIEW_PX,
  GLARE_PEAK,
  GLARE_REFERENCE_DISTANCE,
  GLARE_STRENGTH,
} from './glare-geometry'

function glsl(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : `${x}`
}

// Mirrored by glareQuad in glare-geometry.ts, whose tests cover the
// collapse and sizing: change one, change the other.
const vertexShader = /* glsl */ `
  uniform float uRadius;
  // The view's size, CSS px.
  uniform vec2 uViewport;
  varying vec2 vPx;
  varying float vCore;
  varying float vHalo;
  varying float vAlpha;

  void main() {
    vec3 c = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float d = length(c);
    vPx = vec2(0.0);
    vCore = 1.0;
    vHalo = 1.0;
    vAlpha = 0.0;
    // At or behind the camera plane, inside the Sun, or no viewport size
    // yet (px offsets over a 1 px view would span the screen): zero area,
    // outside the clip volume. Written so NaN collapses too.
    if (
      isOrthographic ||
      !(uViewport.y >= ${glsl(GLARE_MIN_VIEW_PX)}) ||
      !(c.z < -1e-6 * d) ||
      !(d > uRadius)
    ) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      return;
    }
    float tanAlpha = uRadius * inversesqrt(d * d - uRadius * uRadius);
    float disc = tanAlpha * projectionMatrix[1][1] * 0.5 * uViewport.y;
    float alpha = (1.0 - smoothstep(${glsl(GLARE_FADE_PX[0])}, ${glsl(GLARE_FADE_PX[1])}, disc))
      * clamp(sqrt(${glsl(GLARE_REFERENCE_DISTANCE)} / d), ${glsl(GLARE_STRENGTH[0])}, ${glsl(GLARE_STRENGTH[1])});
    if (!(alpha > 0.0)) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      return;
    }
    float core = max(disc, ${glsl(GLARE_CORE_MIN_PX)});
    float halo = min(core * ${glsl(GLARE_HALO_SCALE)}, ${glsl(GLARE_HALO_MAX_PX)});
    // On the ray to the centre, in front of the Sun's sphere (see
    // GLARE_DEPTH_SHARE), so planets between still hide it.
    vec4 clip = projectionMatrix * vec4(c * (${glsl(GLARE_DEPTH_SHARE)} * (1.0 - uRadius / d)), 1.0);
    vPx = position.xy * halo;
    clip.xy += vPx / (0.5 * uViewport) * clip.w;
    vCore = core;
    vHalo = halo;
    vAlpha = alpha;
    gl_Position = clip;
  }
`

const fragmentShader = /* glsl */ `
  varying vec2 vPx;
  varying float vCore;
  varying float vHalo;
  varying float vAlpha;

  void main() {
    float r = length(vPx);
    // A hot core the size of the disc (at least a few px), in a soft halo
    // that is gone before the quad's edge.
    float core = 1.0 - smoothstep(0.5 * vCore, vCore + 1.0, r);
    float halo = exp(-3.0 * r / vHalo) * (1.0 - smoothstep(0.6 * vHalo, vHalo, r));
    float I = min(vAlpha * (0.85 * core + 0.45 * halo), ${glsl(GLARE_PEAK)});
    vec3 col = mix(vec3(1.0, 0.6, 0.3), vec3(1.0, 0.95, 0.85), core);
    gl_FragColor = vec4(col * I, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const viewport = new THREE.Vector4()

// The View's live viewport, in CSS px, into the material's uniform; module
// level so the render hook doesn't mutate a memoised value in place.
function syncViewport(material: THREE.ShaderMaterial, renderer: THREE.WebGLRenderer): void {
  renderer.getCurrentViewport(viewport)
  const ratio = renderer.getPixelRatio()
  const size = material.uniforms.uViewport.value as THREE.Vector2
  size.set(viewport.z / ratio, viewport.w / ratio)
}

/**
 * The Sun as a bright point from afar (tides-2hv.12): a pixel-sized quad on
 * its centre that stays visible when the disc is under a pixel, fading out
 * as the disc grows. Ship mode only; mount inside the Sun's group, whose
 * origin is the Sun's centre. See glare-geometry.ts.
 */
export function SunGlare({ radius }: { radius: number }) {
  const get = useThree((s) => s.get)
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        uniforms: {
          uRadius: { value: radius },
          // The canvas size until the first render reports the View's.
          uViewport: { value: new THREE.Vector2(get().size.width, get().size.height) },
        },
      }),
    [radius, get]
  )
  useEffect(() => () => material.dispose(), [material])

  // At render time, with the viewport the View is drawing into. A prop, so
  // it is in place for the very first frame.
  const onBeforeRender = useCallback(
    (renderer: THREE.WebGLRenderer) => syncViewport(material, renderer),
    [material]
  )

  return (
    <mesh
      onBeforeRender={onBeforeRender}
      frustumCulled={false}
      raycast={() => null}
      material={material}
    >
      <planeGeometry args={[2, 2]} />
    </mesh>
  )
}
