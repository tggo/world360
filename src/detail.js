// "Manga+" style: facade windows drawn by shader, no extra geometry. The same mask is used by the
// colour pass (dark glass -> tone) and the G-buffer pass (a different object id per window -> the
// edge shader outlines every window).
import * as THREE from 'three';

export const detailUniform = { value: 0 };

// p: world position, n: world normal. 1 inside a window, 0 on the wall.
export const WINDOW_GLSL = /* glsl */ `
float w360Window(vec3 p, vec3 n) {
  if (abs(n.y) > 0.3) return 0.;
  vec2 t = normalize(vec2(-n.z, n.x));
  float u = dot(p.xz, t);
  float v = p.y - 0.2;
  if (v < 0.5) return 0.;
  float fl = 3.1;
  float row = floor(v / fl);
  float cv = fract(v / fl);
  float cu = fract(u / 3.3);
  if (row < 0.5) // ground floor: wide shop windows
    return step(abs(cu - 0.5), 0.36) * step(0.12, cv) * step(cv, 0.74);
  return step(abs(cu - 0.5), 0.19) * step(0.3, cv) * step(cv, 0.78);
}
`;

// building material: Lambert + darker glass inside windows when the style is on
export function makeBuildingMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDetail = detailUniform;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float wall;\nvarying float vWall;\nvarying vec3 vWPos;\nvarying vec3 vWN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWall = wall;\nvWPos = (modelMatrix * vec4(transformed, 1.)).xyz;\nvWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uDetail;\nvarying float vWall;\nvarying vec3 vWPos;\nvarying vec3 vWN;\n' + WINDOW_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\nif (uDetail > 0.5 && vWall > 0.5) diffuseColor.rgb *= 1. - 0.62 * w360Window(vWPos, normalize(vWN));');
  };
  m.customProgramCacheKey = () => 'w360-building';
  return m;
}
