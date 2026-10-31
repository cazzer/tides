import{ao as c,ap as u,ar as m,as as v,a3 as p,E as x}from"./index-_or96epk.js";import{e as g,k as y,S as h}from"./tile-features-Cvb1CVeU.js";class S extends c{constructor(d){super(d),this.onBeforeCompile=t=>{t.fragmentShader=t.fragmentShader.replace("#include <bumpmap_pars_fragment>",`
				#ifdef USE_BUMPMAP

					uniform sampler2D bumpMap;
					uniform float bumpScale;

					// relative determinant threshold below which the geometry is considered edge-on
					const float DEGENERATE_DET_EPSILON = 1e-3;

					// central differences at one texel spacing so the gradient interpolates across texels
					vec2 dHdxy_fwd() {

						vec2 dSTdx = dFdx( vBumpMapUv );
						vec2 dSTdy = dFdy( vBumpMapUv );

						vec2 texelSize = 1.0 / vec2( textureSize( bumpMap, 0 ) );
						vec2 dx = vec2( texelSize.x, 0.0 );
						vec2 dy = vec2( 0.0, texelSize.y );
						float gradU = ( texture2D( bumpMap, vBumpMapUv + dx ).x - texture2D( bumpMap, vBumpMapUv - dx ).x ) / ( 2.0 * texelSize.x );
						float gradV = ( texture2D( bumpMap, vBumpMapUv + dy ).x - texture2D( bumpMap, vBumpMapUv - dy ).x ) / ( 2.0 * texelSize.y );

						float dBx = bumpScale * ( gradU * dSTdx.x + gradV * dSTdx.y );
						float dBy = bumpScale * ( gradU * dSTdy.x + gradV * dSTdy.y );

						return vec2( dBx, dBy );

					}

					// unnormalized surface derivatives so the gradient resolves to the physical slope
					vec3 perturbNormalArb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection ) {

						vec3 vSigmaX = dFdx( surf_pos.xyz );
						vec3 vSigmaY = dFdy( surf_pos.xyz );
						vec3 vN = surf_norm; // normalized

						vec3 R1 = cross( vSigmaY, vN );
						vec3 R2 = cross( vN, vSigmaX );

						float fDet = dot( vSigmaX, R1 ) * faceDirection;

						// Edge-on geometry, such as the tile skirts, has a degenerate determinant that
						// amplifies the gradient into a garbage normal, so fall back to the surface normal.
						if ( abs( fDet ) < DEGENERATE_DET_EPSILON * length( vSigmaX ) * length( vSigmaY ) ) {

							return surf_norm;

						}

						vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
						return normalize( abs( fDet ) * surf_norm - vGrad );

					}

				#endif
			`)}}}const s=Symbol("FADE_PARAMS");function E(a,d){if(a[s])return a[s];const t={fadeIn:{value:0},fadeOut:{value:0},fadeTexture:{value:null}};return a[s]=t,a.defines={...a.defines||{},FEATURE_FADE:0},a.onBeforeCompile=e=>{d&&d(e),e.uniforms={...e.uniforms,...t},e.vertexShader=e.vertexShader.replace(/void\s+main\(\)\s+{/,r=>`
					#ifdef USE_BATCHING_FRAG

					varying float vBatchId;

					#endif

					${r}

						#ifdef USE_BATCHING_FRAG

						// add 0.5 to the value to avoid floating error that may cause flickering
						vBatchId = getIndirectIndex( gl_DrawID ) + 0.5;

						#endif
				`),e.fragmentShader=e.fragmentShader.replace(/void main\(/,r=>`
				#if FEATURE_FADE

				// adapted from https://www.shadertoy.com/view/Mlt3z8
				float bayerDither2x2( vec2 v ) {

					return mod( 3.0 * v.y + 2.0 * v.x, 4.0 );

				}

				float bayerDither4x4( vec2 v ) {

					vec2 P1 = mod( v, 2.0 );
					vec2 P2 = floor( 0.5 * mod( v, 4.0 ) );
					return 4.0 * bayerDither2x2( P1 ) + bayerDither2x2( P2 );

				}

				// the USE_BATCHING define is not available in fragment shaders
				#ifdef USE_BATCHING_FRAG

				// functions for reading the fade state of a given batch id
				uniform sampler2D fadeTexture;
				varying float vBatchId;
				vec2 getFadeValues( const in float i ) {

					int size = textureSize( fadeTexture, 0 ).x;
					int j = int( i );
					int x = j % size;
					int y = j / size;
					return texelFetch( fadeTexture, ivec2( x, y ), 0 ).rg;

				}

				#else

				uniform float fadeIn;
				uniform float fadeOut;

				#endif

				#endif

				${r}
			`).replace(/#include <dithering_fragment>/,r=>`

				${r}

				#if FEATURE_FADE

				#ifdef USE_BATCHING_FRAG

				vec2 fadeValues = getFadeValues( vBatchId );
				float fadeIn = fadeValues.r;
				float fadeOut = fadeValues.g;

				#endif

				float bayerValue = bayerDither4x4( floor( mod( gl_FragCoord.xy, 4.0 ) ) );
				float bayerBins = 16.0;
				float dither = ( 0.5 + bayerValue ) / bayerBins;
				if ( dither >= fadeIn ) {

					discard;

				}

				if ( dither < fadeOut ) {

					discard;

				}

				#endif

			`)},t}function T(a){const d=g(a,y),t=new h(1,1,1,1),e=[t],r=[1,0].map(n=>{const i=new S,f=new u(new Float32Array(1),1,1,m,v);i.map=new p,i.displacementMap=f,i.bumpMap=f;const o=d.material(i);return i.dispose(),E(o,o.onBeforeCompile),o.defines.FEATURE_FADE=n,e.push(o,i.map,f),{object:new x(t,o),prepare:()=>!l}});let l=!1;return{probes:r,dispose:()=>{l=!0,e.forEach(n=>n.dispose())}}}export{T as createTileProbes};
