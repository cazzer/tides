uniform float time;
uniform float progress;
uniform sampler2D texture1;
uniform vec4 resolution;
uniform samplerCube uPerlin;
varying vec2 vUv;
varying vec3 vPosition;
varying vec3 vLayer0;
varying vec3 vLayer1;
varying vec3 vLayer2;
varying vec3 vNormal;
varying vec3 eyeVector;
float PI = 3.1415926535897932384626433832795;

vec3 brightnessToColor(float b) {
  b *= .25;
  return (vec3(b, b * b, b*b*b*b) / .25) * 0.6;
}

float supersun() {
  float sum = 0.0;
  sum += textureCube(uPerlin, vLayer0).r;
  sum += textureCube(uPerlin, vLayer1).r;
  sum += textureCube(uPerlin, vLayer2).r;
  sum *=.33;
  return sum;
}

float Fresnel(vec3 eyeVector, vec3 worldNormal) {
  return pow(1.0 + dot(eyeVector, worldNormal), 3.0);
}

void main() {
  float brightness = supersun();
  brightness = brightness * 2.5 + 1.5;

  float fres = Fresnel(eyeVector, vNormal);
  // brightness += fres;

  vec3 col = brightnessToColor(brightness);
  gl_FragColor = vec4(col, 1.0);
  gl_FragColor = vec4(fres);
}
