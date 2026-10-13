// "Manga+" style: facade windows drawn by shader, no extra geometry. The same mask is used by the
// colour pass (dark glass -> tone) and the G-buffer pass (a different object id per window -> the
// edge shader outlines every window).
import * as THREE from 'three';

export const detailUniform = { value: 0 };

// Per-building window style, decided in city.js and passed as vertex attributes:
//   wall  0 = no windows, 1 = windows, 2 = windows + shop fronts on the ground floor
//   win   (bay width m, window width fraction, floor height m, share of windows left out)
//   seed  per-building random (the object id), shifts the grid and picks the left-out windows
export const WINDOW_GLSL = /* glsl */ `
float w360h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float w360Window(vec3 p, vec3 n, float style, vec4 win, float seed) {
  if (style < 0.5 || abs(n.y) > 0.3 || win.x <= 0.) return 0.;
  vec2 t = normalize(vec2(-n.z, n.x));
  float u = dot(p.xz, t) + seed * 97.;
  float v = p.y - 0.2;
  if (v < 0.5) return 0.;
  float row = floor(v / win.z), cv = fract(v / win.z);
  float cell = floor(u / win.x), cu = fract(u / win.x);
  if (style > 1.5 && row < 0.5) return step(abs(cu - 0.5), 0.4) * step(0.1, cv) * step(cv, 0.76);
  if (w360h(vec2(cell, row) + seed * 13.7) < win.w) return 0.;
  return step(abs(cu - 0.5), win.y * 0.5) * step(0.3, cv) * step(cv, 0.8);
}
`;

// building material: Lambert + darker glass inside windows when the style is on
export function makeBuildingMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDetail = detailUniform;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float wall;\nattribute vec4 win;\nattribute float oid;\nvarying float vWall;\nvarying vec4 vWin;\nvarying float vSeed;\nvarying vec3 vWPos;\nvarying vec3 vWN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWall = wall; vWin = win; vSeed = oid;\nvWPos = (modelMatrix * vec4(transformed, 1.)).xyz;\nvWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uDetail;\nvarying float vWall;\nvarying vec4 vWin;\nvarying float vSeed;\nvarying vec3 vWPos;\nvarying vec3 vWN;\n' + WINDOW_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\nif (uDetail > 0.5) diffuseColor.rgb *= 1. - 0.62 * w360Window(vWPos, normalize(vWN), vWall, vWin, vSeed);');
  };
  m.customProgramCacheKey = () => 'w360-building';
  return m;
}
