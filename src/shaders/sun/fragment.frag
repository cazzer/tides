uniform float time;
uniform float progress;
uniform sampler2D texture1;
uniform vec4 resolution;
uniform samplerCube uPerlin;
varying vec2 vUv;
varying vec3 vPosition;
varying vec3 vNormal;
float PI = 3.1415926535897932384626433832795;

void main() {
  gl_FragColor = textureCube(uPerlin, vPosition);
}
