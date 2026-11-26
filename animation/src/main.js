import * as THREE from 'three';

/* ============================================================
   Painterly 3D short — "Memory field"
   Original characters, Arcane-like palette/lighting, pastoral-fantasy world.
   Everything is procedural; frames are rendered deterministically by renderAt(t).
   ============================================================ */

const qs = new URLSearchParams(location.search);
const W = +qs.get('w') || 1280, HH = +qs.get('h') || 720;
const SC = HH / 720;                       // pixel-scale for screen-space effects
const canvas = document.getElementById('c');
canvas.width = W; canvas.height = HH;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, HH, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const ENV = await (await fetch('/audio_env.json')).json();

/* ---------------- utils ---------------- */
const MU = THREE.MathUtils;
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rnd = mulberry32(20261126);
const R = (a, b) => a + (b - a) * rnd();
function h2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vn2(x, y) { const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy); return (h2(ix, iy) * (1 - ux) + h2(ix + 1, iy) * ux) * (1 - uy) + (h2(ix, iy + 1) * (1 - ux) + h2(ix + 1, iy + 1) * ux) * uy; }
function fbm2(x, y) { let a = .5, s = 0; for (let i = 0; i < 4; i++) { s += a * vn2(x, y); x = x * 2.02 + 17.3; y = y * 2.02 + 9.1; a *= .5; } return s; }
const ease = t => t * t * t * (t * (t * 6 - 15) + 10);
const clamp01 = x => Math.min(1, Math.max(0, x));
const lerp = MU.lerp;

const PLATEAU = 2.6;
function terrainH(x, z) {
  const r = Math.hypot(x, z);
  let h = 2.4 * Math.exp(-(r * r) / (2 * 22 * 22));
  h += 2.6 * (fbm2(x * 0.02, z * 0.02) - 0.5) * 2.0;
  h += 0.30 * (fbm2(x * 0.13 + 5, z * 0.13) - 0.5);
  const flat = MU.smoothstep(r, 6, 17);
  return lerp(PLATEAU, h, flat);
}

/* ---------------- lighting constants ---------------- */
const SUN = new THREE.Vector3(-0.30, 0.24, -0.92).normalize();      // direction TO the sun
const COOLDIR = new THREE.Vector3(0.75, 0.45, -0.45).normalize();   // cool rim light from behind-right of the subjects
const FOG = new THREE.Color(0.50, 0.30, 0.46);

const U = {
  uTime: { value: 0 },
  uSun: { value: SUN.clone() },
  uCoolDir: { value: COOLDIR.clone() },
  uRimColor: { value: new THREE.Color(1.0, 0.58, 0.32) },
  uCool: { value: new THREE.Color(0.45, 0.60, 1.0) },
};

/* ---------------- GLSL chunks ---------------- */
const NOISE = `
float hash13(vec3 p){ p = fract(p*0.1031); p += dot(p, p.zyx+31.32); return fract((p.x+p.y)*p.z); }
float vnoise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(mix(hash13(i),hash13(i+vec3(1,0,0)),f.x), mix(hash13(i+vec3(0,1,0)),hash13(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash13(i+vec3(0,0,1)),hash13(i+vec3(1,0,1)),f.x), mix(hash13(i+vec3(0,1,1)),hash13(i+vec3(1,1,1)),f.x),f.y), f.z); }
float fbm3(vec3 p){ float a=.5,s=0.; for(int i=0;i<4;i++){ s+=a*vnoise(p); p=p*2.03+vec3(7.1,3.7,5.3); a*=.5;} return s; }
`;

// soft banded ramp for toon shading
const ramp = (() => {
  const n = 64, d = new Uint8Array(n);
  const bands = 4, k = 0.22;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1), f = x * bands, fl = Math.min(Math.floor(f), bands - 1), fr = f - fl;
    const v = (fl + MU.smoothstep(fr, 0.5 - k, 0.5 + k)) / bands;
    d[i] = Math.round(255 * (0.16 + 0.84 * Math.min(1, v * 1.04)));
  }
  const t = new THREE.DataTexture(d, n, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true; return t;
})();

function toon(color, o = {}) {
  const m = new THREE.MeshToonMaterial({
    color: new THREE.Color(color), gradientMap: ramp, side: o.side ?? THREE.FrontSide,
    emissive: new THREE.Color(o.emissive ?? 0x000000), emissiveIntensity: o.emissiveIntensity ?? 1,
  });
  const rimK = (o.rim ?? 0.8).toFixed(3), ps = (o.ps ?? 2.5).toFixed(3), na = (o.na ?? 0.55).toFixed(3);
  const windH = o.wind === 'blade' ? 'pow(clamp(position.y,0.,1.),1.8)' : o.wind === 'flower' ? '1.0' : '0.0';
  m.customProgramCacheKey = () => 'ptoon:' + JSON.stringify(o);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.uTime; sh.uniforms.uSun = U.uSun; sh.uniforms.uRimColor = U.uRimColor;
    sh.uniforms.uCool = U.uCool; sh.uniforms.uCoolDir = U.uCoolDir;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos; varying vec3 vWNrm; uniform float uTime;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        ${o.wind ? `
        #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3].x, 0.0, instanceMatrix[3].z);
          float wph = ip.x*0.31 + ip.z*0.17;
          float wv = sin(wph + uTime*1.6) + 0.5*sin(wph*2.3 - uTime*2.7) + 0.3*sin(ip.x*0.05 + uTime*0.6) + 0.8;
          float hf = ${windH};
          transformed.x += wv*0.11*hf; transformed.z += wv*0.04*hf;
        #endif` : ''}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 wpp = vec4(transformed,1.0);
        vec3 nn = objectNormal;
        #ifdef USE_INSTANCING
          wpp = instanceMatrix * wpp; nn = mat3(instanceMatrix)*nn;
        #endif
        wpp = modelMatrix * wpp; vWPos = wpp.xyz; vWNrm = normalize(mat3(modelMatrix)*nn);`);
    let groundCode = '', stoneCode = '';
    if (o.ground) groundCode = `
        float g1 = fbm3(vec3(vWPos.x*0.05, 0.0, vWPos.z*0.05));
        float g2 = fbm3(vec3(vWPos.x*0.45, 1.0, vWPos.z*0.45));
        vec3 cA=vec3(0.035,0.19,0.13); vec3 cB=vec3(0.20,0.34,0.10); vec3 cC=vec3(0.45,0.30,0.08); vec3 cT=vec3(0.02,0.12,0.17);
        vec3 gc = mix(cA,cB,smoothstep(0.30,0.70,g1));
        gc = mix(gc,cC,smoothstep(0.55,0.85,g2*0.6+g1*0.55)*0.6);
        gc = mix(gc,cT,smoothstep(0.50,0.20,g1)*0.55);
        diffuseColor.rgb = gc*(0.75+0.5*g2);`;
    if (o.stone) stoneCode = `
        float course = floor(vWPos.y*3.2); float off = mod(course,2.0)*0.5;
        float bx = fract((vWPos.x+vWPos.z)*1.7+off); float by = fract(vWPos.y*3.2);
        float mortar = smoothstep(0.0,0.05,bx)*smoothstep(0.0,0.06,by)*(1.0-smoothstep(0.96,1.0,bx));
        diffuseColor.rgb *= mix(0.55,1.0,mortar);
        float moss = (1.0 - smoothstep(0.0, 2.2, vWPos.y-(${(o.baseY ?? PLATEAU).toFixed(2)}))) * smoothstep(0.35,0.7,fbm3(vWPos*1.3));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05,0.20,0.07), moss*0.75);`;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos; varying vec3 vWNrm; uniform vec3 uSun; uniform vec3 uCoolDir; uniform vec3 uRimColor; uniform vec3 uCool; uniform float uTime;
        ${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float n1 = fbm3(vWPos*${ps});
          float n2 = vnoise(vec3(vWPos.x*1.7, vWPos.y*8.0, vWPos.z*1.7));
          diffuseColor.rgb *= (1.0-${na}*0.5) + ${na}*n1 + (n2-0.5)*0.14;
          ${groundCode}
          ${stoneCode}
        }`)
      .replace('#include <opaque_fragment>', `
        {
          vec3 Nn = normalize(vWNrm); if(!gl_FrontFacing) Nn=-Nn;
          vec3 Vv = normalize(cameraPosition - vWPos);
          float ndv = clamp(dot(Nn,Vv),0.,1.);
          float rim = pow(1.0-ndv, 2.3);
          float sunSide = smoothstep(-0.25, 0.65, dot(Nn,uSun));
          outgoingLight += uRimColor*rim*sunSide*${rimK}*1.7;
          outgoingLight += uCool*pow(1.0-ndv,3.0)*smoothstep(0.25,0.9,dot(Nn,uCoolDir))*${rimK}*0.28;
        }
        #include <opaque_fragment>`);
  };
  return m;
}

/* ---------------- scene, lights ---------------- */
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(FOG, 0.0052);
const camera = new THREE.PerspectiveCamera(40, W / HH, 0.3, 1500);

const sunLight = new THREE.DirectionalLight(new THREE.Color(1.0, 0.60, 0.32), 3.6);
sunLight.position.copy(SUN).multiplyScalar(90).add(new THREE.Vector3(0, PLATEAU, 0));
sunLight.target.position.set(0, PLATEAU, 0);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
Object.assign(sunLight.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 20, far: 170 });
sunLight.shadow.bias = -0.0006; sunLight.shadow.normalBias = 0.03; sunLight.shadow.radius = 3;
scene.add(sunLight, sunLight.target);
scene.add(new THREE.HemisphereLight(new THREE.Color(0.34, 0.40, 0.85), new THREE.Color(0.60, 0.38, 0.25), 0.9));
const rimLight = new THREE.DirectionalLight(new THREE.Color(0.38, 0.52, 1.0), 1.0);
rimLight.position.copy(COOLDIR).multiplyScalar(40).add(new THREE.Vector3(0, PLATEAU, 0));
scene.add(rimLight);
const fillLight = new THREE.DirectionalLight(new THREE.Color(1.0, 0.64, 0.66), 2.0);   // warm soft fill from the camera side
fillLight.position.set(0.15, 0.32, 1.0).normalize().multiplyScalar(40).add(new THREE.Vector3(0, PLATEAU, 0));
scene.add(fillLight);

/* ---------------- sky ---------------- */
{
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uSun: U.uSun, uTime: U.uTime },
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = p.xyww; }`,
    fragmentShader: `varying vec3 vDir; uniform vec3 uSun; uniform float uTime; ${NOISE}
      void main(){
        vec3 dir = normalize(vDir);
        float h = clamp(dir.y,0.,1.);
        float sd = max(dot(dir,uSun),0.);
        vec3 hor = mix(vec3(0.62,0.30,0.50), vec3(1.0,0.46,0.20), pow(sd,2.2));
        vec3 mid = mix(vec3(0.30,0.14,0.42), vec3(0.85,0.24,0.42), pow(sd,1.6));
        vec3 top = mix(vec3(0.03,0.07,0.20), vec3(0.10,0.10,0.32), sd);
        vec3 col = mix(hor, mid, smoothstep(0.0,0.24,h));
        col = mix(col, top, smoothstep(0.14,0.78,h));
        // painterly cloud streaks
        vec2 cuv = dir.xz/(h+0.14);
        float c1 = fbm3(vec3(cuv*vec2(0.55,1.7)+vec2(uTime*0.008,0.0), 0.5));
        float c2 = fbm3(vec3(cuv*vec2(1.3,3.4)+vec2(3.0,uTime*0.004), 4.5));
        float cl = smoothstep(0.44,0.74,c1*0.75+c2*0.45)*smoothstep(0.0,0.10,h)*(1.0-smoothstep(0.55,0.95,h));
        float lit = pow(sd,1.2)*0.9 + 0.22;
        vec3 cc = mix(vec3(0.30,0.15,0.42), vec3(1.0,0.60,0.36), clamp(lit,0.,1.));
        cc += vec3(0.5,0.25,0.12)*pow(sd,3.0)*smoothstep(0.5,0.8,c2);
        col = mix(col, cc, cl*0.9);
        col += vec3(1.0,0.55,0.25)*pow(sd,5.0)*0.55;
        col += vec3(1.0,0.82,0.55)*pow(sd,48.0)*1.3;
        col += vec3(1.0,0.93,0.78)*smoothstep(0.9962,0.9980,sd)*6.0;
        col += vec3(1.0,0.62,0.30)*pow(sd,18.0)*0.7;
        gl_FragColor = vec4(col,1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(800, 48, 24), mat);
  sky.renderOrder = -10; sky.frustumCulled = false; scene.add(sky);
}

/* ---------------- terrain ---------------- */
{
  const g = new THREE.PlaneGeometry(900, 900, 360, 360);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, terrainH(p.getX(i), p.getZ(i)));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, toon(0xffffff, { ground: true, rim: 0.35, na: 0.0 }));
  m.receiveShadow = true; scene.add(m);
}

/* ---------------- distant ridges ---------------- */
function ridge(z, baseH, amp, seed, color, width = 900) {
  const n = 160, pos = [], idx = [];
  for (let i = 0; i <= n; i++) {
    const x = (i / n - 0.5) * width;
    const y = baseH + amp * (Math.pow(fbm2(x * 0.006 + seed, seed * 3.1), 1.4) * 2.2 + 0.6 * Math.max(0, Math.sin(x * 0.0045 + seed * 2.0)));
    pos.push(x, y, 0, x, -30, 0);
    if (i < n) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
  m.position.z = z; scene.add(m); return m;
}
ridge(-520, 6, 85, 1.7, new THREE.Color(0.30, 0.22, 0.46));
ridge(-380, 4, 60, 4.2, new THREE.Color(0.22, 0.17, 0.40));
ridge(-270, 3, 42, 8.5, new THREE.Color(0.16, 0.13, 0.34));
ridge(-190, 1, 28, 12.1, new THREE.Color(0.11, 0.10, 0.28));
ridge(520, 6, 70, 33.0, new THREE.Color(0.22, 0.16, 0.40));   // behind camera side (anti-sun)
ridge(380, 4, 50, 41.0, new THREE.Color(0.16, 0.13, 0.34));

/* ---------------- grass + flowers ---------------- */
function bladeGeo() {
  const g = new THREE.BufferGeometry();
  const pos = [-0.5, 0, 0, 0.5, 0, 0, -0.35, 0.5, 0, 0.35, 0.5, 0, 0, 1, 0];
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
  return g;
}
function scatter(count, spec) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const near = rnd() < spec.nearFrac;
    const rr = near ? Math.sqrt(rnd()) * spec.nearR : spec.nearR + Math.pow(rnd(), 0.8) * (spec.farR - spec.nearR);
    const a = rnd() * Math.PI * 2;
    const x = Math.cos(a) * rr + spec.cx, z = Math.sin(a) * rr + spec.cz;
    pts.push([x, z]);
  }
  return pts;
}
{
  const grassMat = toon(0xffffff, { wind: 'blade', rim: 1.2, ps: 1.2, na: 0.7, side: THREE.DoubleSide });
  const N = 52000;
  const inst = new THREE.InstancedMesh(bladeGeo(), grassMat, N);
  inst.receiveShadow = true; inst.frustumCulled = false;
  const pts = scatter(N, { nearFrac: 0.55, nearR: 12, farR: 55, cx: 0, cz: 2 });
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const [x, z] = pts[i];
    const y = terrainH(x, z);
    const cd = Math.min(Math.hypot(x + 0.9, z - 4.2), Math.hypot(x - 0.5, z - 3.3), Math.hypot(x + 0.2, z - 3.75));
    const hgt = R(0.45, 0.95) * (0.8 + 0.5 * fbm2(x * 0.15, z * 0.15)) * lerp(0.28, 1, MU.smoothstep(Math.hypot(x, z - 0.1), 1.3, 3.8)) * lerp(0.25, 1, MU.smoothstep(cd, 0.9, 2.6));
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
    s.set(R(0.09, 0.15), hgt, 1);
    M.compose(p.set(x, y - 0.02, z), q, s); inst.setMatrixAt(i, M);
    const t = fbm2(x * 0.08, z * 0.08);
    c.setHSL(lerp(0.30, 0.17, MU.smoothstep(t, 0.4, 0.75)) + R(-0.02, 0.02), R(0.45, 0.7), R(0.20, 0.34));
    inst.setColorAt(i, c);
  }
  scene.add(inst);

  // flowers
  const fm = toon(0xffffff, { wind: 'flower', rim: 1.4, ps: 2.0, na: 0.3, emissive: 0x111122, emissiveIntensity: 0.6 });
  const NF = 15000;
  const fi = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.06, 1), fm, NF);
  fi.frustumCulled = false; fi.receiveShadow = true;
  const fp = scatter(NF, { nearFrac: 0.75, nearR: 15, farR: 50, cx: 0, cz: 1 });
  const cols = [[0.58, 0.62, 0.66], [0.73, 0.50, 0.70], [0.0, 0.0, 0.90], [0.93, 0.55, 0.74], [0.12, 0.85, 0.60]];
  for (let i = 0; i < NF; i++) {
    let [x, z] = fp[i];
    if (Math.hypot(x, z - 0.1) < 2.3) { const a = Math.atan2(z - 0.1, x), rr = 2.3 + rnd() * 1.5; x = Math.cos(a) * rr; z = Math.sin(a) * rr + 0.1; }
    if (Math.min(Math.hypot(x + 0.9, z - 4.2), Math.hypot(x - 0.5, z - 3.3), Math.hypot(x + 0.2, z - 3.75)) < 1.5) { x += 2.2; z -= 1.6; }
    const y = terrainH(x, z);
    const patch = fbm2(x * 0.09 + 3, z * 0.09 + 7);
    const k = patch < 0.38 ? 0 : patch < 0.47 ? 1 : patch < 0.56 ? 2 : patch < 0.64 ? 3 : 4;
    const cc = (rnd() < 0.12) ? cols[(rnd() * cols.length) | 0] : cols[k];
    c.setHSL(cc[0] + R(-0.02, 0.02), cc[1], cc[2] * R(0.82, 1.1));
    const sc = R(0.8, 1.7);
    q.identity();
    M.compose(p.set(x, y + R(0.30, 0.78), z), q, s.set(sc, sc * 0.8, sc));
    fi.setMatrixAt(i, M); fi.setColorAt(i, c);
  }
  scene.add(fi);

  // hero foreground flowers (big dabs near the low camera)
  const NH = 110;
  const hi = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.07, 1), fm, NH);
  hi.frustumCulled = false; hi.receiveShadow = true;
  for (let i = 0; i < NH; i++) {
    let x = R(-4.5, 4.5), z = R(0.8, 6.0); if (Math.hypot(x, z - 0.1) < 2.3) z += 2.4; if (Math.hypot(x + 0.2, z - 3.75) < 3.0) x += 4.2; const y = terrainH(x, z);
    const cc = cols[(rnd() * 3) | 0];
    c.setHSL(cc[0] + R(-0.02, 0.02), cc[1], cc[2]);
    const sc = R(0.9, 1.6);
    M.compose(p.set(x, y + R(0.25, 0.7), z), q, s.set(sc, sc, sc));
    hi.setMatrixAt(i, M); hi.setColorAt(i, c);
  }
  scene.add(hi);
}

/* ---------------- ruins ---------------- */
let stoneMat = toon(0x8a8696, { stone: true, rim: 1.0, ps: 1.6, na: 0.6 });
const stoneAt = (y) => toon(0x8a8696, { stone: true, baseY: y, rim: 1.0, ps: 1.6, na: 0.6 });
function box(w, h, d, x, y, z, ry = 0, rz = 0, parent = scene) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d, 2, 2, 2), stoneMat);
  m.position.set(x, y, z); m.rotation.set(0, ry, rz); m.castShadow = m.receiveShadow = true; parent.add(m); return m;
}
function col(r, h, x, y, z, parent = scene, tilt = 0) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.88, r, h, 10, 3), stoneMat);
  m.position.set(x, y + h / 2, z); m.rotation.z = tilt; m.castShadow = m.receiveShadow = true; parent.add(m); return m;
}
{
  const arch = new THREE.Group();
  const ax = -10.5, az = -23, ay = terrainH(ax, az);
  stoneMat = stoneAt(ay);
  arch.position.set(ax, ay - 0.1, az); arch.rotation.y = 0.25;
  col(0.75, 7.5, -3.2, 0, 0, arch); col(0.75, 5.2, 3.2, 0, 0, arch);
  box(9.0, 1.1, 1.3, -0.6, 7.6, 0, 0, 0.05, arch);
  box(1.6, 0.9, 1.3, 3.4, 5.7, 0, 0, -0.1, arch);
  box(2.2, 0.5, 2.0, -3.2, 0.25, 0, 0, 0, arch); box(2.2, 0.5, 2.0, 3.2, 0.25, 0, 0, 0, arch);
  box(3.2, 1.2, 1.1, 6.5, 0.6, 1.5, 0.5, 0.0, arch); box(2.0, 0.8, 1.0, -7.0, 0.4, 1.0, -0.4, 0.0, arch);
  scene.add(arch);
  // scattered stumps and slabs on the plateau edge
  stoneMat = stoneAt(PLATEAU);
  const spots = [[-5.5, -3.5], [6.0, -5], [-8, 3], [4.5, 7], [9, 1.5]];
  spots.forEach(([x, z], i) => { const y = terrainH(x, z); if (i % 2) col(0.45, R(0.8, 2.2), x, y - 0.1, z, scene, R(-0.1, 0.1)); else box(R(1.0, 1.8), R(0.5, 1.2), R(0.4, 0.8), x, y + 0.2, z, R(0, 3), 0.04); });
  // distant tower on the far ridge
  const tx = 100, tz = -150, ty = terrainH(tx, tz);
  stoneMat = stoneAt(ty);
  const tw = new THREE.Group(); tw.position.set(tx, ty - 1, tz);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.2, 46, 10), stoneMat); body.position.y = 23; tw.add(body);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(4.6, 11, 10), toon(0x2a3a5a, { rim: 1.2 })); roof.position.y = 51; tw.add(roof);
  const win = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.7, 0.3), fog: true });
  for (let i = 0; i < 4; i++) { const w = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.2, 0.4), win); const a = i * 1.4; w.position.set(Math.sin(a) * 3.5, 14 + i * 7.5, Math.cos(a) * 3.5); w.rotation.y = a; tw.add(w); }
  scene.add(tw);
}

/* ---------------- memory-light particles ---------------- */
const partU = { uTime: U.uTime, uScale: { value: 1 }, uInt: { value: 1 } };
{
  const N = 1100;
  const pos = new Float32Array(N * 3), seed = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const x = R(-13, 13) * (0.35 + rnd() * 0.65), z = R(-11, 11) * (0.4 + rnd() * 0.6) + 1;
    pos[i * 3] = x; pos[i * 3 + 1] = terrainH(x, z); pos[i * 3 + 2] = z;
    seed[i * 4] = rnd(); seed[i * 4 + 1] = rnd(); seed[i * 4 + 2] = rnd(); seed[i * 4 + 3] = i < 800 ? 0 : 1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: partU,
    vertexShader: `
      attribute vec4 aSeed; uniform float uTime, uScale, uInt; varying vec3 vCol; varying float vA;
      void main(){
        vec3 p = position; float t = uTime;
        bool petal = aSeed.w > 0.5;
        float sp = petal ? 0.35 + aSeed.x*0.4 : 0.30 + aSeed.x*0.55;
        float yy = mod(aSeed.y*11. + t*sp, 11.);
        p.y += yy*(petal?0.55:1.0) + (petal?0.3:0.0);
        p.x += sin(t*0.7 + aSeed.z*20.)*0.7 + t*(petal?1.1:0.35) ; p.x = mod(p.x+14., 28.)-14.;
        p.z += cos(t*0.5 + aSeed.x*17.)*0.6;
        float fade = smoothstep(0.0,1.2,yy)*(1.0-smoothstep(6.5,11.,yy));
        float fl = 0.65+0.35*sin(t*(2.0+aSeed.x*5.0)+aSeed.z*40.);
        float k = aSeed.z;
        vec3 c = k<0.5 ? vec3(0.25,0.95,1.0) : (k<0.82 ? vec3(1.0,0.72,0.30) : vec3(1.0,0.45,0.78));
        if(petal) c = mix(vec3(1.0,0.86,0.92), vec3(0.8,0.9,1.0), aSeed.x);
        vCol = c*(petal?0.55:1.0); vA = fade*fl*uInt*(petal?0.7:1.0);
        vec4 mv = modelViewMatrix*vec4(p,1.0);
        float size = petal ? 0.045+aSeed.x*0.03 : 0.05+aSeed.y*aSeed.y*0.22;
        gl_PointSize = clamp(size*uScale/(-mv.z), 1.0, 90.0);
        gl_Position = projectionMatrix*mv;
      }`,
    fragmentShader: `varying vec3 vCol; varying float vA;
      void main(){ float d = length(gl_PointCoord-0.5)*2.0; float a = smoothstep(1.0,0.0,d); a = a*a; gl_FragColor = vec4(vCol*a*vA*1.4, a*vA); }`,
  });
  const pts = new THREE.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = 5; scene.add(pts);
}

/* ============================================================
   Characters
   ============================================================ */
const Y = new THREE.Vector3(0, 1, 0);
function placeLimb(m, a, b) {
  const d = b.clone().sub(a), len = Math.max(d.length(), 1e-4);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(Y, d.normalize());
  m.scale.set(1, len, 1);
}
function ik2(s, t, l1, l2, pole) {
  const d = t.clone().sub(s);
  const dist = MU.clamp(d.length(), Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.999);
  const dir = d.normalize();
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
  const base = s.clone().addScaledVector(dir, a);
  const pv = pole.clone().sub(s); const proj = pv.addScaledVector(dir, -pv.dot(dir)).normalize();
  return { elbow: base.addScaledVector(proj, h), hand: s.clone().addScaledVector(dir, dist) };
}
function sph(r, mat, parent, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, shadow = true) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), mat);
  m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.castShadow = shadow; m.receiveShadow = true; parent.add(m); return m;
}
function makeTube(nSeg, radial) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((nSeg + 1) * radial * 3), 3));
  const idx = [];
  for (let i = 0; i < nSeg; i++) for (let j = 0; j < radial; j++) {
    const a = i * radial + j, b = i * radial + (j + 1) % radial, c = (i + 1) * radial + j, d = (i + 1) * radial + (j + 1) % radial;
    idx.push(a, c, b, b, c, d);
  }
  g.setIndex(idx); return g;
}
const _T = new THREE.Vector3(), _N = new THREE.Vector3(), _B = new THREE.Vector3(), _ref = new THREE.Vector3(0, 0, 1), _ref2 = new THREE.Vector3(1, 0, 0);
function updateTube(geo, pts, radii, radial, flat = 1) {
  const pos = geo.attributes.position.array, n = pts.length;
  for (let i = 0; i < n; i++) {
    _T.subVectors(pts[Math.min(i + 1, n - 1)], pts[Math.max(i - 1, 0)]).normalize();
    _N.crossVectors(_T, _ref); if (_N.lengthSq() < 1e-3) _N.crossVectors(_T, _ref2); _N.normalize();
    _B.crossVectors(_T, _N).normalize();
    for (let j = 0; j < radial; j++) {
      const a = j / radial * Math.PI * 2, cx = Math.cos(a) * radii[i] * flat, cy = Math.sin(a) * radii[i], o = (i * radial + j) * 3;
      pos[o] = pts[i].x + _N.x * cx + _B.x * cy; pos[o + 1] = pts[i].y + _N.y * cx + _B.y * cy; pos[o + 2] = pts[i].z + _N.z * cx + _B.z * cy;
    }
  }
  geo.attributes.position.needsUpdate = true; geo.computeVertexNormals(); geo.computeBoundingSphere();
}
class Strand {
  constructor(parent, mat, n, radial, r0, r1, flat = 1.8) {
    this.n = n; this.radial = radial; this.geo = makeTube(n - 1, radial); this.flat = flat;
    this.radii = Array.from({ length: n }, (_, i) => { const s = i / (n - 1); return r0 * Math.pow(1 - s, 0.85) + r1 * s; });
    this.pts = Array.from({ length: n }, () => new THREE.Vector3());
    this.mesh = new THREE.Mesh(this.geo, mat); this.mesh.frustumCulled = false; this.mesh.castShadow = true; this.mesh.receiveShadow = true; parent.add(this.mesh);
  }
  update(base, dir, len, wind, t, phase, amp) {
    for (let i = 0; i < this.n; i++) {
      const s = i / (this.n - 1);
      const p = this.pts[i];
      p.copy(base).addScaledVector(dir, len * s);
      const w = amp * Math.pow(s, 1.5) * (0.75 + 0.25 * Math.sin(t * 2.3 + phase - s * 4.0));
      p.addScaledVector(wind, w * len);
      p.y += 0.04 * len * s * s * Math.sin(t * 1.7 + phase * 1.3 - s * 3.0) * amp * 2.0 - 0.35 * len * s * s * amp * 0.0;
      p.z += 0.03 * len * s * Math.sin(t * 2.9 + phase) * amp * 3.0;
    }
    updateTube(this.geo, this.pts, this.radii, this.radial, this.flat);
  }
}
class Cloth {
  constructor(parent, mat, w, h, sx, sy, topY, z) {
    this.geo = new THREE.PlaneGeometry(w, h, sx, sy); this.base = this.geo.attributes.position.array.slice(); this.w = w; this.h = h;
    this.mesh = new THREE.Mesh(this.geo, mat); this.mesh.position.set(0, topY - h / 2, z); this.mesh.castShadow = this.mesh.receiveShadow = true; this.mesh.frustumCulled = false; parent.add(this.mesh);
  }
  update(wind, t, flare = 0.5, billow = 0.06) {
    const p = this.geo.attributes.position.array, b = this.base;
    for (let i = 0; i < p.length; i += 3) {
      const x = b[i], y = b[i + 1], v = clamp01(0.5 - y / this.h);       // 0 top .. 1 bottom
      const wv = Math.pow(v, 1.4);
      p[i] = x * (1 + flare * v) + wind.x * wv * 0.28 + 0.05 * wv * Math.sin(t * 3.1 + x * 7.0 - v * 5.0);
      p[i + 1] = y + 0.12 * wv * Math.abs(wind.x) * Math.sin(t * 2.2 + x * 3.0);
      p[i + 2] = b[i + 2] - billow * Math.sin(v * Math.PI) - wv * 0.04 + wind.z * wv * 0.5 + 0.05 * wv * Math.sin(t * 2.6 + x * 6.0 - v * 5.0) + 0.032 * Math.sin(x * 17.0 + 0.7 + 0.6 * Math.sin(v * 3.0 + t * 0.5)) * (0.25 + v);
    }
    this.geo.attributes.position.needsUpdate = true; this.geo.computeVertexNormals();
  }
}

function makeFace(head, o) {
  const skin = o.skinMat;
  const face = new THREE.Group(); head.add(face);
  const eyes = [], lidMat = toon(0x2a1a22, { rim: 0 });
  const whiteM = toon(0xf4efe9, { rim: 0.2, na: 0, emissive: 0x6a625a }), irisM = toon(o.eye, { rim: 0, na: 0, emissive: new THREE.Color(o.eye).multiplyScalar(0.5) });
  const irisD = toon(new THREE.Color(o.eye).multiplyScalar(0.35), { rim: 0, na: 0 });
  const pupilM = toon(0x120a12, { rim: 0, na: 0 }), hiM = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (const sd of [-1, 1]) {
    const e = new THREE.Group();
    e.position.set(sd * o.eyeX, o.eyeY, Math.sqrt(Math.max(o.headR * o.headR - (o.eyeX * o.eyeX) - (o.eyeY * o.eyeY), 1e-5)) * 1.0 + 0.002);
    e.rotation.y = sd * Math.asin(o.eyeX / o.headR) * 0.95;
    const add = (geo, mat, x, y, z, sx = 1, sy = 1) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.scale.set(sx, sy, 1); m.castShadow = false; e.add(m); return m; };
    const circ = new THREE.CircleGeometry(1, 24);
    add(circ, whiteM, 0, 0, 0, o.eyeW, o.eyeH);
    add(circ, irisD, 0, -0.002, 0.0006, o.eyeW * 0.66, o.eyeH * 0.84);
    add(circ, irisM, 0, -0.004, 0.0012, o.eyeW * 0.52, o.eyeH * 0.62);
    add(circ, pupilM, 0, -0.002, 0.0018, o.eyeW * 0.22, o.eyeH * 0.30);
    add(circ, hiM, sd * -o.eyeW * 0.22, o.eyeH * 0.30, 0.0024, o.eyeW * 0.14, o.eyeH * 0.16);
    add(circ, hiM, sd * o.eyeW * 0.2, -o.eyeH * 0.32, 0.0024, o.eyeW * 0.07, o.eyeH * 0.08);
    // upper lid line (dark arc)
    const lid = new THREE.Mesh(new THREE.RingGeometry(0.93, 1.14, 28, 1, 0.12, Math.PI * 0.78), lidMat);
    lid.scale.set(o.eyeW, o.eyeH, 1); lid.rotation.z = (sd > 0 ? 0.0 : Math.PI * 0.10); lid.position.z = 0.003; e.add(lid);
    // lash flick
    const lash = new THREE.Mesh(new THREE.BoxGeometry(o.eyeW * 0.5, o.eyeH * 0.12, 0.001), lidMat);
    lash.position.set(sd * o.eyeW * 0.92, o.eyeH * 0.58, 0.003); lash.rotation.z = sd * 0.5; e.add(lash);
    // lower lid mask for blinking: skin colored plane that scales down
    const lidSkin = new THREE.Mesh(new THREE.CircleGeometry(1.25, 20), skin); lidSkin.scale.set(o.eyeW, o.eyeH, 1); lidSkin.position.set(0, o.eyeH * 1.0, 0.0045); e.add(lidSkin);
    e.userData.lidSkin = lidSkin; e.userData.base = o.eyeH;
    face.add(e); eyes.push(e);
  }
  // brows
  const browM = toon(o.brow, { rim: 0, na: 0 });
  for (const sd of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(o.eyeW * 2.1, 0.0045, 0.004), browM);
    b.position.set(sd * o.eyeX, o.eyeY + o.eyeH * 1.9, Math.sqrt(Math.max(o.headR * o.headR - o.eyeX * o.eyeX - Math.pow(o.eyeY + o.eyeH * 1.9, 2), 1e-5)) + 0.001);
    b.rotation.y = sd * Math.asin(o.eyeX / o.headR) * 0.9; b.rotation.z = sd * -0.12; face.add(b); eyes.push(b);
  }
  // nose + mouth
  sph(0.012, skin, head, 0, o.eyeY - 0.045, o.headR * 0.985, 1, 1.1, 1.3, false);
  const mouthM = toon(0x7a1f30, { rim: 0, na: 0, emissive: 0x2a0710 });
  const mouth = new THREE.Mesh(new THREE.CircleGeometry(1, 18), mouthM);
  mouth.position.set(0, o.mouthY, o.mouthZ);
  face.add(mouth);
  return { eyes, mouth, mouthW: o.mouthW };
}

function blinkAmt(t, seed) {
  const period = 3.4 + (seed % 3) * 0.6; const ph = ((t + seed * 1.7) % period);
  if (ph > period - 0.18) { const k = (ph - (period - 0.18)) / 0.18; return Math.sin(k * Math.PI); }
  return 0;
}
function applyFace(f, mouthOpen, blink, smile = 0.0) {
  for (const e of f.eyes) if (e.userData.lidSkin) {
    const ls = e.userData.lidSkin; const base = e.userData.base;
    ls.position.y = base * (1.0 - 1.9 * blink * 0.5 + 0.0) + (1 - blink) * base * 0.12 + base * 0.0;
    ls.position.y = lerp(base * 1.4, -base * 0.1, blink);
  }
  f.mouth.scale.set(f.mouthW * (1 + smile * 0.3 - mouthOpen * 0.15), 0.0042 + mouthOpen * 0.021 + smile * 0.0015, 1);
  f.mouth.position.y = f.mouth.position.y; // static anchor
}

/* ---- Elf mage (original design: silver twin-tails, deep teal robe, crystal staff) ---- */
function buildElf() {
  const root = new THREE.Group(); const body = new THREE.Group(); root.add(body);
  const skin = toon(0xf1d3bf, { rim: 1.1, na: 0.15 }), cloth = toon(0x17404f, { rim: 0.9, na: 0.5, ps: 4, side: THREE.DoubleSide });
  const clothLight = toon(0x2c6a74, { rim: 0.9, na: 0.5, ps: 4, side: THREE.DoubleSide });
  const gold = toon(0xc9a14a, { rim: 1.4, na: 0.2, emissive: 0x2a1a00 });
  const hairM = toon(0xcdd4e8, { rim: 0.8, na: 0.3, ps: 5, side: THREE.DoubleSide });
  const prof = [[0.37, 0.04], [0.35, 0.25], [0.29, 0.6], [0.20, 0.88], [0.145, 1.02], [0.17, 1.2], [0.20, 1.33], [0.11, 1.42], [0.06, 1.47]].map(p => new THREE.Vector2(p[0], p[1]));
  const robe = new THREE.Mesh(new THREE.LatheGeometry(prof, 32), cloth); robe.castShadow = robe.receiveShadow = true; body.add(robe);
  const trim = new THREE.Mesh(new THREE.LatheGeometry([[0.372, 0.03], [0.368, 0.1]].map(p => new THREE.Vector2(p[0], p[1])), 32), gold); body.add(trim);
  const sash = new THREE.Mesh(new THREE.LatheGeometry([[0.215, 0.93], [0.2, 1.0]].map(p => new THREE.Vector2(p[0], p[1])), 24), clothLight); body.add(sash);
  const collar = new THREE.Mesh(new THREE.LatheGeometry([[0.13, 1.40], [0.16, 1.36], [0.19, 1.31]].map(p => new THREE.Vector2(p[0], p[1])), 24), toon(0xe8e2d8, { rim: 1.2, side: THREE.DoubleSide })); body.add(collar);
  const mantle = new THREE.Mesh(new THREE.TorusGeometry(0.155, 0.05, 10, 28), toon(0xece6da, { rim: 1.0, na: 0.3 }));
  mantle.rotation.x = Math.PI / 2; mantle.position.y = 1.355; mantle.scale.set(1, 1, 0.75); mantle.castShadow = true; body.add(mantle);
  sph(0.026, gold, body, 0, 1.29, 0.17);
  const cape = new Cloth(body, toon(0x1b4558, { rim: 0.9, na: 0.5, ps: 4, side: THREE.DoubleSide }), 0.42, 1.3, 10, 14, 1.40, -0.17);
  // head
  const head = new THREE.Group(); head.position.set(0, 1.6, 0); body.add(head);
  const headR = 0.115;
  sph(headR, skin, head, 0, 0, 0, 0.97, 1.07, 1.0);
  sph(0.075, skin, head, 0, -0.07, 0.03, 1, 0.9, 0.95);                            // jaw
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.052, 0.12, 12), skin); neck.position.y = 1.47; body.add(neck);
  sph(0.128, hairM, head, 0, 0.022, -0.026, 1, 1.02, 1.0);                         // hair cap
  sph(0.11, hairM, head, 0, -0.09, -0.075, 0.95, 1.5, 0.75);                        // back mass
  for (const sd of [-1, 1]) {                                                       // pointed ears
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.16, 8), skin);
    ear.position.set(sd * 0.125, 0.015, -0.01); ear.rotation.set(0, sd * 0.35, -sd * (Math.PI / 2 - 0.28)); ear.castShadow = true; head.add(ear);
  }
  // bangs
  for (let i = 0; i < 9; i++) {
    const a = MU.mapLinear(i, 0, 8, -1.05, 1.05);
    const b = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.115, 6), hairM);
    b.position.set(Math.sin(a) * 0.1, 0.075 - Math.abs(a) * 0.012, Math.cos(a) * 0.095);
    b.rotation.set(Math.PI * 0.12 * (1 + 0.2 * Math.cos(a)), 0, -a * 0.5 + (a > 0 ? 0.05 : -0.05)); b.rotation.z += Math.PI; b.castShadow = true; head.add(b);
  }
  const face = makeFace(head, { skinMat: skin, eye: 0x24b58a, brow: 0x9aa0b4, headR, eyeX: 0.047, eyeY: 0.0, eyeW: 0.027, eyeH: 0.032, mouthW: 0.017, mouthY: -0.075, mouthZ: 0.103 });
  // twin tails + extra back strands
  const tails = [];
  for (const sd of [-1, 1]) for (let k = 0; k < 3; k++) {
    tails.push({ sd, k, s: new Strand(body, hairM, 18, 8, 0.042 - k * 0.008, 0.004, 1.9) });
  }
  const back = [];
  for (let k = 0; k < 5; k++) back.push({ k, s: new Strand(body, hairM, 12, 8, 0.05, 0.006, 1.6) });
  // arms
  const armU = [], armF = [], hands = [], joints = [];
  for (const sd of [-1, 1]) {
    const u = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.04, 1, 10), cloth); u.castShadow = true; body.add(u); armU.push(u);
    const f = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.037, 1, 14, 1, true), clothLight); f.castShadow = true; body.add(f); armF.push(f);
    const hnd = sph(0.036, skin, body); hands.push(hnd);
    joints.push(sph(0.047, cloth, body), sph(0.043, cloth, body));
  }
  // staff
  const staff = new THREE.Group(); body.add(staff);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.021, 1.95, 8), toon(0x3a2a24, { rim: 0.8 })); pole.position.y = 0.97; pole.castShadow = true; staff.add(pole);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 8, 20), gold); ring.position.y = 1.99; ring.rotation.x = 0.4; staff.add(ring);
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.055, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 1.0, 1.0) })); crystal.scale.y = 1.7; crystal.position.y = 2.0; staff.add(crystal);
  const glow = new THREE.PointLight(new THREE.Color(0.4, 0.95, 1.0), 0.35, 2.4, 2.0); glow.position.y = 2.0; staff.add(glow);
  staff.position.set(-0.31, 0, 0.12);

  const S = { L: new THREE.Vector3(-0.2, 1.36, 0.0), Rr: new THREE.Vector3(0.2, 1.36, 0.0) };
  const tmpW = new THREE.Vector3();
  return {
    root, body, head, face, speaking: 0,
    update(t, st) {
      const { windWorld, yaw, headYaw, headPitch, mouth, blink, smile } = st;
      root.rotation.y = yaw; body.position.y = 0.004 * Math.sin(t * 1.5);
      body.rotation.z = 0.012 * Math.sin(t * 0.7);
      head.rotation.set(headPitch + 0.03 * mouth, headYaw, 0.02 * Math.sin(t * 0.9));
      const wl = windWorld.clone().applyAxisAngle(Y, -yaw);
      cape.update(wl, t, 0.55, 0.05);
      // hair
      const hq = head.quaternion;
      const hb = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(hq).add(head.position);
      for (const { sd, k, s } of tails) {
        const base = hb(sd * (0.095 + k * 0.012), 0.045 - k * 0.012, -0.04 - k * 0.012);
        const dir = new THREE.Vector3(sd * (0.22 + k * 0.08), -1, -0.10 - k * 0.05).normalize();
        s.update(base, dir, 0.95 - k * 0.05, wl, t, k * 1.3 + sd, 0.55);
      }
      for (const { k, s } of back) {
        const base = hb((k - 2) * 0.04, 0.0, -0.105);
        const dir = new THREE.Vector3((k - 2) * 0.05, -1, -0.05).normalize();
        s.update(base, dir, 0.42 + 0.06 * Math.sin(k * 2.0), wl, t, k * 0.9, 0.45);
      }
      // arms: right hand grips staff, left hand relaxed
      const sw = 0.012 * Math.sin(t * 1.3);
      const lT = new THREE.Vector3(-0.31, 1.02 + sw, 0.13), rT = new THREE.Vector3(0.27, 0.84 + sw, 0.07);
      const poleR = new THREE.Vector3(0.55, 1.0, -0.45), poleL = new THREE.Vector3(-0.55, 1.0, -0.45);
      [[1, S.Rr, rT, poleR], [0, S.L, lT, poleL]].forEach(([i, sh, tg, pl]) => {
        const r = ik2(sh, tg, 0.30, 0.29, pl);
        placeLimb(armU[i], sh, r.elbow); placeLimb(armF[i], r.elbow, r.hand);
        hands[i].position.copy(r.hand); joints[i * 2].position.copy(sh); joints[i * 2 + 1].position.copy(r.elbow);
      });
      staff.rotation.z = -0.02 + 0.01 * Math.sin(t * 0.8);
      crystal.rotation.y = t * 0.8; glow.intensity = 0.32 + 0.06 * Math.sin(t * 2.1);
      applyFace(face, mouth, blink, smile);
    },
    crystalWorld() { return crystal.getWorldPosition(tmpW); },
  };
}

/* ---- Young traveler (original design: scarf, short cape, spiky dark hair) ---- */
function buildTraveler() {
  const root = new THREE.Group(); const body = new THREE.Group(); root.add(body);
  const skin = toon(0xe9bfa2, { rim: 1.1, na: 0.15 });
  const tunic = toon(0x8d5a2e, { rim: 1.2, na: 0.5, ps: 4, side: THREE.DoubleSide });
  const leather = toon(0x3a2a22, { rim: 1.0, na: 0.4 });
  const capeM = toon(0x2a3f66, { rim: 0.9, na: 0.5, ps: 4, side: THREE.DoubleSide });
  const scarfM = toon(0xd2492b, { rim: 1.0, na: 0.4, ps: 5, side: THREE.DoubleSide, emissive: 0x1a0500 });
  const hairM = toon(0x2b1f24, { rim: 1.0, na: 0.3, ps: 6 });
  const pants = toon(0x232638, { rim: 1.0, na: 0.4 });
  const prof = [[0.27, 0.68], [0.25, 0.85], [0.17, 1.03], [0.185, 1.2], [0.20, 1.3], [0.10, 1.37], [0.07, 1.4]].map(p => new THREE.Vector2(p[0], p[1]));
  const shirt = new THREE.Mesh(new THREE.LatheGeometry(prof, 28), tunic); shirt.castShadow = shirt.receiveShadow = true; body.add(shirt);
  const belt = new THREE.Mesh(new THREE.LatheGeometry([[0.176, 0.97], [0.18, 1.04]].map(p => new THREE.Vector2(p[0], p[1])), 24), leather); body.add(belt);
  const legM = [], boots = [];
  for (const sd of [-1, 1]) {
    const l = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.062, 0.78, 10), pants); l.position.set(sd * 0.085, 0.4, 0); l.castShadow = l.receiveShadow = true; body.add(l); legM.push(l);
    const bt = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.22, 0.2), leather); bt.position.set(sd * 0.085, 0.11, 0.03); bt.castShadow = true; body.add(bt); boots.push(bt);
  }
  const cape = new Cloth(body, capeM, 0.46, 0.85, 10, 10, 1.34, -0.2);
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.38, 0.14), leather); pack.position.set(0, 1.02, -0.3); pack.castShadow = true; body.add(pack);
  const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.38, 10), toon(0x6a5a46, { rim: 1.0 })); roll.rotation.z = Math.PI / 2; roll.position.set(0, 1.26, -0.31); roll.castShadow = true; body.add(roll);
  const head = new THREE.Group(); head.position.set(0, 1.5, 0); body.add(head);
  const headR = 0.118;
  sph(headR, skin, head, 0, 0, 0, 1.0, 1.04, 1.0); sph(0.078, skin, head, 0, -0.065, 0.03, 1, 0.9, 0.95);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.052, 0.1, 12), skin); neck.position.y = 1.39; body.add(neck);
  sph(0.131, hairM, head, 0, 0.024, -0.03, 1, 1.0, 1.0);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2, rr = 0.1 + 0.02 * ((i * 7) % 3);
    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.036, 0.13 + 0.03 * ((i * 5) % 3), 6), hairM);
    const px = Math.sin(a) * rr, pz = Math.cos(a) * rr - 0.02, py = 0.08 + 0.02 * Math.cos(a * 2.0);
    sp.position.set(px, py, pz); sp.lookAt(px * 2.4, py * 2.2 + 0.1, pz * 2.4 - 0.02); sp.rotateX(Math.PI / 2); sp.castShadow = true; head.add(sp);
  }
  for (const sd of [-1, 1]) { const e = sph(0.026, skin, head, sd * 0.118, -0.005, -0.005, 0.6, 1.0, 0.8); }
  const face = makeFace(head, { skinMat: skin, eye: 0xd98a2b, brow: 0x2b1f24, headR, eyeX: 0.047, eyeY: 0.0, eyeW: 0.025, eyeH: 0.029, mouthW: 0.0175, mouthY: -0.075, mouthZ: 0.105 });
  // scarf ring + trailing tail
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.083, 0.036, 8, 20), scarfM); ring.rotation.x = Math.PI / 2; ring.position.y = 1.385; ring.castShadow = true; body.add(ring);
  const scarfTail = [new Strand(body, scarfM, 16, 8, 0.036, 0.018, 1.9), new Strand(body, scarfM, 14, 8, 0.032, 0.016, 1.9)];
  // arms
  const armU = [], armF = [], hands = [], joints = [];
  for (const sd of [-1, 1]) {
    const u = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.04, 1, 10), tunic); u.castShadow = true; body.add(u); armU.push(u);
    const f = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.035, 1, 10), tunic); f.castShadow = true; body.add(f); armF.push(f);
    hands.push(sph(0.037, skin, body)); joints.push(sph(0.046, tunic, body), sph(0.042, tunic, body));
  }
  const S = { L: new THREE.Vector3(-0.2, 1.26, 0), Rr: new THREE.Vector3(0.2, 1.26, 0) };
  return {
    root, body, head, face,
    update(t, st) {
      const { windWorld, yaw, headYaw, headPitch, mouth, blink, smile, hand } = st;
      root.rotation.y = yaw; body.position.y = 0.004 * Math.sin(t * 1.5 + 1.0);
      head.rotation.set(headPitch + 0.035 * mouth, headYaw, 0.02 * Math.sin(t * 0.8 + 2.0));
      const wl = windWorld.clone().applyAxisAngle(Y, -yaw);
      cape.update(wl, t, 0.5, 0.05);
      scarfTail.forEach((s, i) => {
        const base = new THREE.Vector3(-0.05 + i * 0.1, 1.37, -0.09);
        s.update(base, new THREE.Vector3(0.2 - i * 0.2, -0.55, -0.7).normalize(), 0.62 - i * 0.12, wl.clone().multiplyScalar(1.2), t, i * 1.7 + 0.4, 0.5);
      });
      const sw = 0.012 * Math.sin(t * 1.2 + 1.0);
      const lT = new THREE.Vector3(-0.27, 0.80 + sw, 0.06);
      const rT = new THREE.Vector3(lerp(0.27, 0.12, hand), lerp(0.80, 1.12, hand) + sw, lerp(0.06, 0.2, hand));
      [[1, S.Rr, rT, new THREE.Vector3(0.6, 1.1, -0.4)], [0, S.L, lT, new THREE.Vector3(-0.6, 1.1, -0.4)]].forEach(([i, sh, tg, pl]) => {
        const r = ik2(sh, tg, 0.29, 0.27, pl);
        placeLimb(armU[i], sh, r.elbow); placeLimb(armF[i], r.elbow, r.hand);
        hands[i].position.copy(r.hand); joints[i * 2].position.copy(sh); joints[i * 2 + 1].position.copy(r.elbow);
      });
      applyFace(face, mouth, blink, smile);
    },
  };
}

const elf = buildElf(), trav = buildTraveler();
const ys = terrainH(0, 0);
scene.add(elf.root, trav.root);
elf.root.position.set(0.55, ys, 0.0);
trav.root.position.set(-0.55, ys, 0.22);
elf.root.traverse(o => { o.castShadow = o.isMesh; });
trav.root.traverse(o => { o.castShadow = o.isMesh; });

/* ---------------- timeline / camera ---------------- */
const TOTAL = ENV.total;
const off = ENV.offsets, durs = ENV.durs;
function envAt(clip, t) {
  const k = (t - off[clip]) * ENV.fps; if (k < 0 || k >= ENV.env[clip].length - 1) return 0;
  const i = Math.floor(k), f = k - i; return lerp(ENV.env[clip][i], ENV.env[clip][i + 1], f);
}
const P = (x, y, z) => new THREE.Vector3(x, y, z);
const shots = [
  { t0: 0.0, t1: 6.2, a: { p: P(-1.5, ys + 2.4, 11.5), l: P(-0.7, ys + 1.9, -4), fov: 42 }, b: { p: P(-0.45, ys + 1.75, 5.6), l: P(-0.05, ys + 1.75, -4), fov: 35 } },
  { t0: 6.2, t1: 10.0, a: { p: P(-0.9, ys + 0.85, 4.2), l: P(0.0, ys + 1.5, -0.4), fov: 38 }, b: { p: P(0.5, ys + 1.0, 3.3), l: P(0.0, ys + 1.62, -0.3), fov: 35 } },
  { t0: 10.0, t1: 15.4, a: { p: P(0.55, ys + 1.52, 4.4), l: P(0.0, ys + 1.52, 0.1), fov: 31 }, b: { p: P(0.25, ys + 1.52, 3.4), l: P(0.0, ys + 1.52, 0.1), fov: 29 } },
  { t0: 15.4, t1: TOTAL + 1, a: { p: P(0.05, ys + 1.70, 1.95), l: P(0.5, ys + 1.66, 0.0), fov: 27 }, b: { p: P(0.12, ys + 1.70, 1.35), l: P(0.52, ys + 1.66, 0.0), fov: 23 } },
];
const wind = P(1.0, 0.12, 0.35).normalize();

const _la = new THREE.Vector3();
function setCamera(t) {
  const sh = shots.find(s => t >= s.t0 && t < s.t1) ?? shots[shots.length - 1];
  const k = ease(clamp01((t - sh.t0) / (Math.min(sh.t1, TOTAL) - sh.t0)));
  camera.position.lerpVectors(sh.a.p, sh.b.p, k);
  _la.lerpVectors(sh.a.l, sh.b.l, k);
  camera.position.x += 0.012 * Math.sin(t * 0.9) + 0.006 * Math.sin(t * 2.3);
  camera.position.y += 0.010 * Math.sin(t * 0.7 + 1.0);
  camera.lookAt(_la);
  camera.fov = lerp(sh.a.fov, sh.b.fov, k); camera.updateProjectionMatrix();
}
function pose(t) {
  const turn = ease(clamp01((t - 8.5) / 1.5));                       // they turn toward each other near the end of line 2
  const BODY = 0.8;
  const elfYaw = lerp(Math.PI, Math.PI * 1.5 + BODY, turn), travYaw = lerp(Math.PI, Math.PI * 0.5 - BODY, turn);
  const sp3 = envAt(2, t), sp4 = envAt(3, t);
  const tHead = ease(clamp01((t - 11.2) / 0.9));
  const elfStare = ease(clamp01((t - 15.2) / 1.0));
  return {
    elf: { windWorld: wind.clone().multiplyScalar(0.8 + 0.35 * Math.sin(t * 0.55)), yaw: elfYaw, headYaw: lerp(-0.12, -0.2, turn) + 0.05 * Math.sin(t * 0.5), headPitch: lerp(-0.03, 0.06, elfStare) + 0.015 * Math.sin(t * 0.6), mouth: sp4 * 0.95, blink: blinkAmt(t, 1), smile: elfStare * 0.7 },
    trav: { windWorld: wind.clone().multiplyScalar(0.8 + 0.3 * Math.sin(t * 0.6 + 1)), yaw: travYaw, headYaw: 0.1 * Math.sin(t * 0.45) * (1 - turn) + 0.2 * turn, headPitch: lerp(0.0, -0.04, tHead) + 0.012 * Math.sin(t * 0.7), mouth: sp3 * 0.95, blink: blinkAmt(t, 2), smile: 0.0, hand: ease(clamp01((t - 10.3) / 0.6)) * (1 - ease(clamp01((t - 14.6) / 0.8))) },
  };
}
function intensity(t) { // memory-light amount
  return lerp(0.30, 0.50, clamp01(t / 6)) + 0.9 * ease(clamp01((t - 6.0) / 1.4)) * (1 - 0.45 * ease(clamp01((t - 10.0) / 1.5))) + 0.5 * ease(clamp01((t - 15.5) / 3.0));
}

/* ============================================================
   Post-processing: painterly (rotated Kuwahara) + canvas/grade
   ============================================================ */
const rtOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true };
const rt0 = new THREE.WebGLRenderTarget(W, HH, rtOpts);
rt0.depthTexture = new THREE.DepthTexture(W, HH); rt0.depthTexture.type = THREE.UnsignedIntType;
const rt1 = new THREE.WebGLRenderTarget(W, HH, { ...rtOpts, depthBuffer: false });
const quadGeo = new THREE.PlaneGeometry(2, 2);
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const common = `varying vec2 vUv; uniform vec2 uRes; uniform float uNear, uFar; ${NOISE}
  float linD(float z){ float n = z*2.-1.; return 2.*uNear*uFar/(uFar+uNear-n*(uFar-uNear)); }`;
const vs = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.,1.); }`;
const kuw = new THREE.ShaderMaterial({
  depthTest: false, depthWrite: false,
  uniforms: { tColor: { value: rt0.texture }, tDepth: { value: rt0.depthTexture }, uRes: { value: new THREE.Vector2(W, HH) }, uNear: { value: camera.near }, uFar: { value: camera.far }, uSC: { value: SC }, uTime: U.uTime },
  vertexShader: vs,
  fragmentShader: `${common} uniform sampler2D tColor, tDepth; uniform float uSC, uTime;
    vec3 fetch(vec2 uv){ return min(texture2D(tColor, uv).rgb, vec3(6.0)); }
    void main(){
      float d = linD(texture2D(tDepth, vUv).x);
      float rF = 2.6 + 3.0*smoothstep(8.0, 70.0, d) + 2.2*(1.0-smoothstep(0.9, 2.4, d));
      // sky keeps a bit more structure
      if (d > 900.0) rF = 3.2;
      int Rr = int(clamp(rF*uSC + 0.5, 1.0, 7.0));
      vec2 texel = 1.0/uRes;
      // flow angle field: strokes follow soft noise swirls
      float ang = (fbm3(vec3(vUv*vec2(3.2,1.8)*3.0, 0.3)) - 0.5)*2.4 + 0.35;
      float ca = cos(ang), sa = sin(ang);
      mat2 rot = mat2(ca, sa, -sa, ca);
      vec3 mean[4]; float var[4];
      for (int k = 0; k < 4; k++) {
        vec2 sg = vec2((k==0||k==2) ? -1.0 : 1.0, (k<2) ? -1.0 : 1.0);
        vec3 s1 = vec3(0.0), s2 = vec3(0.0); float n = 0.0;
        for (int j = 0; j <= 7; j++) { if (j > Rr) break;
          for (int i = 0; i <= 7; i++) { if (i > Rr) break;
            vec2 o = rot * (vec2(float(i), float(j)) * sg) * texel;
            vec3 c = fetch(vUv + o); s1 += c; s2 += c*c; n += 1.0; } }
        mean[k] = s1/n; vec3 v = s2/n - mean[k]*mean[k]; var[k] = v.r + v.g + v.b;
      }
      vec3 res = mean[0]; float mv = var[0];
      for (int k = 1; k < 4; k++) if (var[k] < mv) { mv = var[k]; res = mean[k]; }
      gl_FragColor = vec4(res, 1.0);
    }`,
});
const fin = new THREE.ShaderMaterial({
  depthTest: false, depthWrite: false,
  uniforms: { tPaint: { value: rt1.texture }, tScene: { value: rt0.texture }, tDepth: { value: rt0.depthTexture }, uRes: { value: new THREE.Vector2(W, HH) }, uNear: { value: camera.near }, uFar: { value: camera.far }, uSC: { value: SC }, uTime: U.uTime, uFade: { value: 1 }, uFrame: { value: 0 } },
  vertexShader: vs,
  fragmentShader: `${common} uniform sampler2D tPaint, tScene, tDepth; uniform float uSC, uTime, uFade, uFrame;
    float ld(vec2 uv){ return log(linD(texture2D(tDepth, uv).x)); }
    vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
    void main(){
      vec2 px = 1.0/uRes;
      vec3 col = texture2D(tPaint, vUv).rgb;
      // soft bloom from the unpainted scene
      vec3 bl = vec3(0.0);
      for (int i = 0; i < 12; i++) {
        float a = float(i)*0.5236 + 0.2; float r = (i%2==0 ? 10.0 : 24.0)*uSC;
        vec3 c = texture2D(tScene, vUv + vec2(cos(a),sin(a))*r*px).rgb;
        bl += max(c - vec3(1.0), 0.0);
      }
      col += bl/12.0 * vec3(1.0,0.72,0.55) * 0.9;
      // painted edge accent
      float dC = ld(vUv), dl = ld(vUv-vec2(px.x*1.5,0.0)), dr = ld(vUv+vec2(px.x*1.5,0.0)), du = ld(vUv+vec2(0.0,px.y*1.5)), dd = ld(vUv-vec2(0.0,px.y*1.5));
      float e = abs(dl-dr)+abs(du-dd);
      float ink = smoothstep(0.10, 0.45, e) * (1.0 - smoothstep(60.0, 220.0, exp(dC)));
      col = mix(col, col*vec3(0.30,0.28,0.42), ink*0.45);
      // exposure + filmic
      col = aces(col*0.92);
      col = mix(col, col*col*(3.0-2.0*col), 0.38);
      // split-tone grade: teal shadows / amber highlights, mild saturation lift
      float l = dot(col, vec3(0.299,0.587,0.114));
      vec3 sh = col*vec3(0.93,0.98,1.06) + vec3(0.0,0.004,0.014);
      vec3 hi = col*vec3(1.08,0.97,0.86);
      col = mix(sh, hi, smoothstep(0.12, 0.70, l));
      col = mix(vec3(dot(col,vec3(0.299,0.587,0.114))), col, 1.12);
      // canvas weave + brush grain
      vec2 pp = gl_FragCoord.xy/uSC;
      float weave = 0.5 + 0.25*sin(pp.x*1.9)*sin(pp.y*1.9) + 0.25*sin(pp.x*0.95+pp.y*0.3)*sin(pp.y*0.95-pp.x*0.3);
      float fiber = vnoise(vec3(pp*vec2(0.35,0.9), 1.0))*0.6 + vnoise(vec3(pp*vec2(0.9,0.28), 2.0))*0.4;
      float brush = vnoise(vec3(pp*vec2(0.06,0.5), 3.0));
      float shade = 1.0 - l;
      col *= 1.0 + ((weave-0.5)*0.10 + (fiber-0.5)*0.12 + (brush-0.5)*0.10)*(0.7+0.6*shade);
      // vignette
      vec2 q = vUv-0.5; col *= 1.0 - 0.55*pow(dot(q*vec2(1.0,0.9),q*vec2(1.0,0.9))*2.0, 1.4);
      col *= 1.0 - 0.28*smoothstep(0.38, 0.0, vUv.y);
      // grain
      float gr = hash13(vec3(gl_FragCoord.xy, uFrame)) - 0.5; col += gr*0.022;
      col *= uFade;
      col = pow(max(col, 0.0), vec3(1.0/2.2));
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const quad = new THREE.Mesh(quadGeo, kuw);
const postScene = new THREE.Scene(); postScene.add(quad);

function renderAt(t, frameNo = 0) {
  U.uTime.value = t;
  setCamera(t);
  const ps = pose(t);
  elf.update(t, ps.elf); trav.update(t, ps.trav);
  partU.uScale.value = HH / (2 * Math.tan(camera.fov * Math.PI / 360));
  partU.uInt.value = intensity(t);
  kuw.uniforms.uNear.value = fin.uniforms.uNear.value = camera.near;
  kuw.uniforms.uFar.value = fin.uniforms.uFar.value = camera.far;
  fin.uniforms.uFade.value = Math.min(ease(clamp01(t / 0.9)), 1 - ease(clamp01((t - (TOTAL - 1.0)) / 0.95)));
  fin.uniforms.uFrame.value = frameNo % 97;
  renderer.setRenderTarget(rt0); renderer.clear(); renderer.render(scene, camera);
  quad.material = kuw; renderer.setRenderTarget(rt1); renderer.render(postScene, postCam);
  quad.material = fin; renderer.setRenderTarget(null); renderer.render(postScene, postCam);
}
window.renderAt = renderAt;
window.__TOTAL = TOTAL;
window.__ready = true;
