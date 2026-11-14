import * as THREE from 'three';

/**
 * Sky dome around the camera: colour from the sun's elevation above the local
 * horizon (day, dusk, night), a sun disc, and a fade to black space with
 * altitude. Drawn first without depth so everything else covers it.
 */
export class Sky {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uSun: { value: new THREE.Vector3(1, 0, 0) },
    uUp: { value: new THREE.Vector3(0, 1, 0) },
    uSpace: { value: 1 },
  };

  constructor() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      // Blended, but kept in the opaque pass so it is drawn first (behind everything).
      transparent: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSun;
        uniform vec3 uUp;
        uniform float uSpace;
        varying vec3 vDir;
        ${SKY_GLSL}
        void main() {
          vec3 d = normalize(vDir);
          float sunE = dot(uSun, uUp);
          float day = smoothstep(-0.18, 0.18, sunE);
          vec3 col = skyColor(d, uSun, uUp);
          float sd = max(dot(d, uSun), 0.0);
          col += vec3(1.0, 0.92, 0.75) * (smoothstep(0.9995, 0.99975, sd) * 4.0 + pow(sd, 10.0) * 0.22 * day);
          float alpha = (1.0 - uSpace) * mix(0.55, 1.0, day);
          gl_FragColor = vec4(col, alpha);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20), mat);
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
    this.mesh.scale.setScalar(5000);
  }

  /** Place around the camera. `space` 0 = ground, 1 = orbit. */
  update(cam: THREE.Vector3, sun: THREE.Vector3, up: THREE.Vector3, space: number): void {
    this.mesh.position.copy(cam);
    this.uniforms.uSun.value.copy(sun);
    this.uniforms.uUp.value.copy(up);
    this.uniforms.uSpace.value = space;
    this.mesh.visible = space < 0.999;
  }
}

/** Shared sky colour model (GLSL); `horizonColor` mirrors it on the CPU for fog. */
const SKY_GLSL = /* glsl */ `
  vec3 skyColor(vec3 d, vec3 sun, vec3 up) {
    float h = dot(d, up);
    float sunE = dot(sun, up);
    float day = smoothstep(-0.18, 0.18, sunE);
    vec3 zenith = mix(vec3(0.02, 0.03, 0.08), vec3(0.16, 0.38, 0.82), day);
    vec3 horizon = mix(vec3(0.07, 0.09, 0.17), vec3(0.66, 0.8, 0.95), day);
    float dusk = smoothstep(0.32, 0.0, abs(sunE)) * smoothstep(-0.25, 0.02, sunE);
    float toward = 0.5 + 0.5 * dot(normalize(d - up * h), normalize(sun - up * sunE + 1e-5));
    horizon = mix(horizon, vec3(0.98, 0.55, 0.3), dusk * (0.35 + 0.65 * toward));
    vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.55));
    return mix(col, horizon * 0.75, clamp(-h * 4.0, 0.0, 1.0));
  }
`;

/** Colour of the sky at the horizon (for fog), matching the shader. */
export function horizonColor(sunElevation: number, out: THREE.Color): THREE.Color {
  const day = smoothstep(-0.18, 0.18, sunElevation);
  const r = 0.07 + (0.66 - 0.07) * day, g = 0.09 + (0.8 - 0.09) * day, b = 0.17 + (0.95 - 0.17) * day;
  const dusk = smoothstep(0.32, 0, Math.abs(sunElevation)) * smoothstep(-0.25, 0.02, sunElevation) * 0.5;
  return out.setRGB(r + (0.98 - r) * dusk, g + (0.55 - g) * dusk, b + (0.3 - b) * dusk);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Star field on a large sphere that follows the camera. */
export function makeStarField(): THREE.Points {
  const n = 3000;
  const p = new Float32Array(n * 3);
  const c = new Float32Array(n * 3);
  let s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1;
    const t = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    p[i * 3] = r * Math.cos(t);
    p[i * 3 + 1] = u;
    p[i * 3 + 2] = r * Math.sin(t);
    const b = 0.55 + 0.45 * rnd();
    const warm = rnd();
    c[i * 3] = b * (0.85 + 0.15 * warm);
    c[i * 3 + 1] = b * 0.9;
    c[i * 3 + 2] = b * (1 - 0.15 * warm);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, vertexColors: true, depthWrite: false, depthTest: false, fog: false }));
  pts.renderOrder = -20;
  pts.frustumCulled = false;
  pts.scale.setScalar(4000);
  return pts;
}
