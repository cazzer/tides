uniform float time;
uniform float progress;
uniform sampler2D texture1;
uniform vec4 resolution;
uniform samplerCube uPerlin;
uniform float glowIntensity; // Add control for glow brightness
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

float Fresnel(vec3 eyeVector, vec3 worldNormal) {
  return pow(1.0 - dot(eyeVector, worldNormal), 3.0);
}

void main() {
  // Normalize the interpolated vectors
  vec3 normal = normalize(vNormal);
  vec3 eyeVector = normalize(cameraPosition - vWorldPosition);
  
  // Fix: Pass parameters in correct order (eyeVector first, normal second)
  // float fres = Fresnel(eyeVector, normal);
  // float gradient = 1. - fres;
  // gradient = clamp(gradient, 0.0, .9);
  float gradient = dot(normal, eyeVector);
  gradient = pow(gradient, 2.0); 
  
  vec3 centerColor = vec3(1.0, 0.8, 0.2);
  vec3 edgeColor = vec3(0.8, 0.2, 0.0);
  
  vec3 col = mix(edgeColor, centerColor, gradient);
  
  gl_FragColor = vec4(col, gradient);
}
