// Two passes + composite:
//  1. colour pass (lit, shadows) -> tColor
//  2. G-buffer pass (view normal + object id) -> tNormal, with depth -> tDepth
//  3. full-screen shader: edges from id/normal/depth jumps, screentone from luminance
import * as THREE from 'three';
import { detailUniform, WINDOW_GLSL } from './detail.js';

const gbufMat = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    attribute float oid;
    attribute float wall;
    uniform float uDetail;
    varying vec3 vN;
    varying float vId;
    varying float vWall;
    varying vec3 vWPos;
    varying vec3 vWN;
    #include <common>
    void main() {
      #include <beginnormal_vertex>
      #include <defaultnormal_vertex>
      #include <begin_vertex>
      #include <project_vertex>
      vN = normalize(transformedNormal);
      vId = oid;
      vWall = wall;
      vWPos = (modelMatrix * vec4(transformed, 1.)).xyz;
      vWN = normalize(mat3(modelMatrix) * objectNormal);
    }`,
  fragmentShader: /* glsl */ `
    uniform float uDetail;
    varying vec3 vN;
    varying float vId;
    varying float vWall;
    varying vec3 vWPos;
    varying vec3 vWN;
    ${WINDOW_GLSL}
    void main() {
      vec3 n = normalize(vN);
      if (!gl_FrontFacing) n = -n;
      float id = vId;
      // each window gets its own id, so the edge pass outlines it
      if (uDetail > 0.5 && vWall > 0.5 && w360Window(vWPos, normalize(vWN)) > 0.5) id = fract(vId + 0.5);
      gl_FragColor = vec4(n, id);
    }`,
  uniforms: { uDetail: detailUniform },
  side: THREE.DoubleSide,
});

const compositeMat = new THREE.ShaderMaterial({
  uniforms: {
    tColor: { value: null }, tNormal: { value: null }, tDepth: { value: null },
    res: { value: new THREE.Vector2() }, near: { value: 1 }, far: { value: 1000 },
    mode: { value: 3 }, lineW: { value: 1.2 }, normalTh: { value: 0.75 }, depthTh: { value: 0.04 },
    toneSize: { value: 5 }, toneStart: { value: 0.35 }, toneOpacity: { value: 1 }, pattern: { value: 0 },
    betaTh: { value: 0.12 }, whiteOut: { value: 0.88 }, transparent: { value: 0 }, sky: { value: new THREE.Color('#dfe8ef') },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tColor, tNormal, tDepth;
    uniform vec2 res; uniform float near, far;
    uniform int mode, pattern; uniform float lineW, normalTh, depthTh;
    uniform float toneSize, toneStart, toneOpacity, betaTh, whiteOut, transparent;
    uniform vec3 sky;
    varying vec2 vUv;

    float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
      return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
    float cloudFbm(vec2 p) { float a = 0.5, s = 0.; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
    float lin(float d) { float z = d * 2. - 1.; return 2. * near * far / (far + near - z * (far - near)); }

    float edgeAt(vec2 uv, vec4 g0, float d0, vec2 o) {
      vec4 g1 = texture2D(tNormal, uv + o);
      float d1 = lin(texture2D(tDepth, uv + o).x);
      if (abs(g1.a - g0.a) > 1e-4) return 1.;
      if (g0.a < 0.) return 0.;
      if (dot(g0.xyz, g1.xyz) < normalTh) return 1.;
      if (abs(d1 - d0) / min(d0, d1) > depthTh * (1. + d0 / 400.)) return 1.;
      return 0.;
    }

    void main() {
      vec2 px = 1. / res;
      float s = res.y / 1000.;                  // scale lines/tones with output size
      vec4 g0 = texture2D(tNormal, vUv);
      float d0 = lin(texture2D(tDepth, vUv).x);
      bool isSky = g0.a < 0.;
      vec3 col = pow(texture2D(tColor, vUv).rgb, vec3(1. / 2.2));
      vec3 skyc = pow(sky, vec3(1. / 2.2));

      // edges, supersampled over a small disc of radius lineW
      float w = max(0.6, lineW * s);
      float e = 0.;
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.785398;
        e = max(e, edgeAt(vUv, g0, d0, vec2(cos(a), sin(a)) * w * px));
      }
      // thinner lines in the distance
      if (!isSky) e *= clamp(1.4 - d0 / 1500., 0.35, 1.);

      vec3 outc;
      if (mode == 0) { outc = isSky ? skyc : col; }
      else if (mode == 1) { outc = isSky ? skyc : col * (1. - 0.85 * e); }
      else {
        float ink = 0.;
        if (mode >= 3 && !isSky) {
          float L = dot(col, vec3(0.299, 0.587, 0.114));
          float dark = clamp((1. - L - toneStart) / max(0.01, 1. - toneStart), 0., 1.);
          if (L > whiteOut) dark = 0.;
          vec2 p = gl_FragCoord.xy / (toneSize * s);
          float t;
          if (pattern == 0) {                    // dots, 45deg grid
            vec2 q = mat2(0.7071, -0.7071, 0.7071, 0.7071) * p;
            vec2 f = fract(q) - 0.5;
            t = step(length(f), sqrt(dark) * 0.72);
          } else if (pattern == 1) {             // parallel lines
            float f = fract((p.x + p.y) * 0.7071);
            t = step(abs(f - 0.5), dark * 0.5);
          } else {                               // cross-hatch
            float f1 = abs(fract((p.x + p.y) * 0.7071) - 0.5);
            float f2 = abs(fract((p.x - p.y) * 0.7071) - 0.5);
            t = max(step(f1, dark * 0.35), step(0.5, dark) * step(f2, (dark - 0.5) * 0.5));
          }
          ink = t * toneOpacity;
          if (L < betaTh) ink = 1.;             // solid black fill
        }
        ink = max(ink, e);
        outc = vec3(1. - ink);
        if (transparent > 0.5) { gl_FragColor = vec4(0., 0., 0., ink); return; }
      }
      if (mode == 4 && isSky && transparent < 0.5) {
        // inked cumulus: contour of a stretched noise field, light hatching on the shaded underside
        vec2 q = gl_FragCoord.xy / (s * vec2(420., 150.));
        float n = cloudFbm(q + vec2(3.1, 7.7));
        float band = smoothstep(0.25, 0.75, vUv.y);
        float c = n * band;
        float line = 1. - smoothstep(0.6, 1.3, abs(c - 0.5) / max(fwidth(c), 1e-4));
        float under = step(0.5, c) * step(c, 0.535) * step(abs(fract((gl_FragCoord.x - gl_FragCoord.y) / (4.5 * s)) - 0.5), 0.12);
        outc = vec3(1. - max(line, under * 0.6));
      }
      if (transparent > 0.5 && isSky) { gl_FragColor = vec4(0.); return; }
      gl_FragColor = vec4(outc, 1.);
    }`,
  depthTest: false, depthWrite: false,
});

export class MangaRenderer {
  constructor(canvas) {
    this.r = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, alpha: true });
    this.r.shadowMap.enabled = true;
    this.r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.r.outputColorSpace = THREE.SRGBColorSpace;
    this.quadScene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compositeMat);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.u = compositeMat.uniforms;
    this.size = new THREE.Vector2(1, 1);
    this.supersample = 2;
  }

  ensureTargets(w, h) {
    if (this.colorRT && this.colorRT.width === w && this.colorRT.height === h) return;
    this.colorRT?.dispose(); this.gRT?.dispose();
    this.colorRT = new THREE.WebGLRenderTarget(w, h, { samples: 4, colorSpace: THREE.LinearSRGBColorSpace });
    this.gRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType) });
    this.gRT.depthTexture.format = THREE.DepthFormat;
  }

  setSize(w, h) {
    this.size.set(w, h);
    this.r.setPixelRatio(1);
    this.r.setSize(w, h, false);
  }

  render(scene, camera, w = this.size.x, h = this.size.y) {
    const ss = this.supersample;
    const W = Math.round(w * ss), H = Math.round(h * ss);
    this.ensureTargets(W, H);
    const r = this.r;
    // colour
    r.setRenderTarget(this.colorRT);
    r.setClearColor(0xffffff, 1);
    r.clear();
    r.render(scene, camera);
    // g-buffer
    const bg = scene.background; scene.background = null;
    scene.overrideMaterial = gbufMat;
    r.setRenderTarget(this.gRT);
    r.setClearColor(new THREE.Color(0, 0, 0), -1);
    r.clear();
    const sm = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false;
    r.render(scene, camera);
    r.shadowMap.autoUpdate = sm;
    scene.overrideMaterial = null; scene.background = bg;
    // composite
    this.u.tColor.value = this.colorRT.texture;
    this.u.tNormal.value = this.gRT.texture;
    this.u.tDepth.value = this.gRT.depthTexture;
    this.u.res.value.set(W, H);
    this.u.near.value = camera.near; this.u.far.value = camera.far;
    r.setRenderTarget(null);
    r.setClearColor(0xffffff, 0);
    r.clear();
    // composite renders at supersampled res into canvas of w*h -> browser-side downscale is not
    // available, so render into an intermediate and downsample with linear filtering
    if (ss !== 1) {
      if (!this.outRT || this.outRT.width !== W || this.outRT.height !== H) {
        this.outRT?.dispose();
        this.outRT = new THREE.WebGLRenderTarget(W, H, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
      }
      r.setRenderTarget(this.outRT);
      r.render(this.quadScene, this.quadCam);
      r.setRenderTarget(null);
      this.blit(this.outRT.texture, ss);
    } else {
      r.render(this.quadScene, this.quadCam);
    }
  }

  blit(tex, ss) {
    if (!this.blitScene) {
      this.blitMat = new THREE.ShaderMaterial({
        uniforms: { t: { value: null }, texel: { value: new THREE.Vector2() } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
        // 2x2 box filter over the supersampled image (bilinear tap at pixel corners)
        fragmentShader: `uniform sampler2D t; uniform vec2 texel; varying vec2 vUv;
          void main(){ vec2 o = texel * 0.5;
            gl_FragColor = 0.25 * (texture2D(t, vUv + vec2(-o.x,-o.y)) + texture2D(t, vUv + vec2(o.x,-o.y))
              + texture2D(t, vUv + vec2(-o.x,o.y)) + texture2D(t, vUv + vec2(o.x,o.y))); }`,
        depthTest: false, depthWrite: false, transparent: false,
      });
      this.blitScene = new THREE.Scene();
      const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMat);
      q.frustumCulled = false;
      this.blitScene.add(q);
    }
    this.blitMat.uniforms.t.value = tex;
    this.blitMat.uniforms.texel.value.set(1 / tex.image.width * (ss - 1), 1 / tex.image.height * (ss - 1));
    this.r.render(this.blitScene, this.quadCam);
  }
}
