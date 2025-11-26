uniform float time;
uniform float progress;
uniform sampler2D texture1;
uniform vec4 resolution;
uniform samplerCube uPerlin;
uniform float glowIntensity;
varying vec2 vUv;
varying vec3 vPosition;
varying vec3 vLayer0;
varying vec3 vLayer1;
varying vec3 vLayer2;
varying vec3 vNormal;
varying vec3 vEyeVector;
varying vec3 vWorldPosition;
float PI = 3.1415926535897932384626433832795;

vec3 brightnessToColor(float b) {
  b *= .25;
  return (vec3(b, b * b, b*b*b*b) / .25) * 0.6;
}

void main() {
  // Calculate eye vector per-fragment
  vec3 eyeVector = normalize(cameraPosition - vWorldPosition);
  vec3 normal = normalize(vNormal);
  
  // Debug: Visualize the dot product directly
  float gradient = max(0.0, dot(normal, eyeVector));
  
  // Uncomment these lines one at a time to debug:
  // gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0); // Visualize normals
  // gl_FragColor = vec4(eyeVector * 0.5 + 0.5, 1.0); // Visualize eye vector
  // gl_FragColor = vec4(gradient, gradient, gradient, 1.0); // Visualize gradient as grayscale
  
  gradient = pow(gradient, 2.0);
  
  vec3 centerColor = vec3(1.0, 0.8, 0.2);
  vec3 edgeColor = vec3(0.8, 0.2, 0.0);
  
  vec3 col = mix(edgeColor, centerColor, gradient);
  
  gl_FragColor = vec4(col, gradient);
}
