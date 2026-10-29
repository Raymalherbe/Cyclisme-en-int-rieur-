/* ════════════════════════════════════════════════════════════
   VÉLO 3D v70 · application
   Partie 1/2 : Three.js, cycliste, vélo, physique, caméra
   ════════════════════════════════════════════════════════════ */

(() => {
'use strict';

try {

// ============================================================
// CONSTANTES & UTILS
// ============================================================
const $ = id => document.getElementById(id);
const ST = 8;                              // pas d'échantillonnage route (m)
const CD = 0.32;                           // coef aéro (CdA)
const RHO = 1.2;                           // densité air
const CRR = 0.004;                         // résistance roulement
const G0 = 9.81;                           // gravité
const FIT_EPOCH = 631065600;               // 1989-12-31 00:00 UTC

// --- Profil utilisateur (persistant) ---
const DEFAULT_PROFILE = { weight: 75, ftp: 220, hrMax: 185, units: 'metric' };
let profile = { ...DEFAULT_PROFILE };
try {
  const s = JSON.parse(localStorage.getItem('velo3d-profile') || 'null');
  if (s && typeof s === 'object') profile = { ...DEFAULT_PROFILE, ...s };
} catch (e) {}
function saveProfile() {
  try { localStorage.setItem('velo3d-profile', JSON.stringify(profile)); } catch (e) {}
}
function zonesFromFTP(ftp) {
  const pcts = [0, .55, .75, .90, 1.05, 1.20, 1.50];
  return pcts.map((p, i) => ({
    name: `Z${i + 1}`,
    min: Math.round(ftp * (i === 0 ? 0 : pcts[i])),
    max: Math.round(ftp * (i === 6 ? 2.0 : pcts[i + 1] || ftp * 1.5))
  }));
}
function zoneOf(power) {
  const z = zonesFromFTP(profile.ftp);
  for (let i = z.length - 1; i >= 0; i--) if (power >= z[i].min) return z[i];
  return z[0];
}

// --- Toast / progrès ---
const toast = t => { $('msg').textContent = t; };
const prog = (f, t) => {
  const p = Math.max(0, Math.min(100, Math.round(f * 100)));
  $('pf').style.width = p + '%';
  $('pb').setAttribute('aria-valuenow', String(p));
  toast(t);
};

// --- État global ---
let route = null, world = null, proj = null;
let s = 0, v = 0, running = false, totalDistance = 0;
let rideElapsed = 0;
let sessionSamples = [], lastSampleT = 0, sessionStart = 0;
let kcal = 0;
let ctl = null, lastP = 0, hr = 0, cad = 0, busy = false;

// ============================================================
// THREE.JS SETUP
// ============================================================
if (typeof THREE === 'undefined')
  throw new Error("Three.js n'a pas pu être chargé. Vérifiez la connexion Internet.");

const R = new THREE.WebGLRenderer({ canvas: $('c'), antialias: true, powerPreference: 'high-performance' });
R.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
R.outputEncoding = THREE.sRGBEncoding;
R.toneMapping = THREE.ACESFilmicToneMapping;
R.toneMappingExposure = 1.05;
R.shadowMap.enabled = true;
R.shadowMap.type = THREE.PCFSoftShadowMap;

const S = new THREE.Scene();
S.background = new THREE.Color(0xb8d7e3);
S.fog = new THREE.Fog(0xb8d7e3, 180, 800);
const cam = new THREE.PerspectiveCamera(55, 1, .1, 1800);

// Ciel dégradé
(function sky() {
  const geo = new THREE.SphereGeometry(1400, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x4a90d9) },
      bottom: { value: new THREE.Color(0xd5e8f0) },
      offset: { value: 200 },
      exponent: { value: 0.6 }
    },
    vertexShader: `varying vec3 vWorldPosition;
      void main(){vec4 wp=modelMatrix*vec4(position,1.0);vWorldPosition=wp.xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `uniform vec3 top;uniform vec3 bottom;uniform float offset;uniform float exponent;
      varying vec3 vWorldPosition;
      void main(){float h=normalize(vWorldPosition+vec3(0.0,offset,0.0)).y;gl_FragColor=vec4(mix(bottom,top,max(pow(max(h,0.0),exponent),0.0)),1.0);}`
  });
  S.add(new THREE.Mesh(geo, mat));
})();

// Lumières
S.add(new THREE.HemisphereLight(0xf3f9ff, 0x777b4f, .85));
const sun = new THREE.DirectionalLight(0xfff4df, 1.2);
sun.position.set(35, 60, -25);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 160 });
sun.shadow.bias = -.0005;
sun.shadow.normalBias = .035;
S.add(sun, sun.target);

// ============================================================
// UTILS GÉOMÉTRIQUES
// ============================================================
const V3 = THREE.Vector3, UPV = new V3(0, 1, 0);

function setBar(mesh, p, q, radius) {
  const d = new V3(q[0]-p[0], q[1]-p[1], q[2]-p[2]);
  const l = d.length() || .001;
  mesh.position.set((p[0]+q[0])/2, (p[1]+q[1])/2, (p[2]+q[2])/2);
  mesh.quaternion.setFromUnitVectors(UPV, d.divideScalar(l));
  mesh.scale.set(radius, l, radius);
}
function r4Seg(mesh, a, b, r) {
  const d = new V3().subVectors(b, a);
  const l = d.length();
  mesh.position.copy(a).add(b).multiplyScalar(.5);
  if (l > .00001) {
    mesh.quaternion.setFromUnitVectors(UPV, d.multiplyScalar(1 / l));
    mesh.scale.set(r, l, r);
  } else {
    mesh.scale.set(r, .00001, r);
  }
  return mesh;
}
function r4Aim(group, a, b) {
  const d = new V3().subVectors(b, a);
  group.position.copy(a);
  if (d.lengthSq() > .0000001) group.quaternion.setFromUnitVectors(UPV, d.normalize());
  return group;
}

// ============================================================
// ROUE AÉRO
// ============================================================
function r4AeroRimGeometry(depthMm) {
  const seg = 64;
  const outer = .310;
  const inner = Math.max(.205, outer - depthMm / 1000);
  const oH = .012, iH = .019;
  const rings = [];
  for (let i = 0; i <= seg; i++) {
    const a = i / seg * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    rings.push([
      [-oH, outer * c, outer * s],
      [oH, outer * c, outer * s],
      [iH, inner * c, inner * s],
      [-iH, inner * c, inner * s]
    ]);
  }
  const pos = [], idx = [];
  for (let i = 0; i < seg; i++) {
    for (let side = 0; side < 4; side++) {
      const next = (side + 1) % 4;
      const base = pos.length / 3;
      pos.push(
        ...rings[i][side], ...rings[i][next],
        ...rings[i + 1][next], ...rings[i + 1][side]
      );
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
function r4SpokeGeometry(depthMm) {
  const rad = Math.max(.205, .310 - depthMm / 1000) + .004;
  const pos = [];
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * Math.PI * 2;
    const x0 = i % 2 ? -.025 : .025;
    const x1 = i % 2 ? .043 : -.043;
    pos.push(x0, 0, 0, x1, Math.cos(a) * rad, Math.sin(a) * rad);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}
function r4SetRimDepth(data, d) {
  d = Math.max(35, Math.min(90, Number(d) || 50));
  for (const w of data.wheels) {
    const oR = w.userData.rim.geometry, oS = w.userData.spokes.geometry;
    w.userData.rim.geometry = r4AeroRimGeometry(d);
    w.userData.spokes.geometry = r4SpokeGeometry(d);
    oR.dispose();
    oS.dispose();
  }
  data.rimDepth = d;
}
function r4ApplyCyclistStyle(data, style = {}) {
  if (style.rimColor) data.materials.rim.color.set(style.rimColor);
  if (style.frameColor && data.materials.frame) data.materials.frame.color.set(style.frameColor);
  if (style.helmetColor) data.materials.helmet.color.set(style.helmetColor);
  if (style.jerseyColor) {
    data.materials.jersey.color.set(style.jerseyColor);
    data.materials.sleeve.color.set(style.jerseyColor);
  }
  if (style.shortColor) {
    data.materials.shorts.color.set(style.shortColor);
    data.materials.waist.color.set(style.shortColor);
  }
  if (style.shoeColor) data.materials.shoe.color.set(style.shoeColor);
  if (style.sockColor) data.materials.sock.color.set(style.sockColor);
  if (style.skinColor) data.materials.skin.color.set(style.skinColor);
  if (style.hairColor && data.materials.hair) data.materials.hair.color.set(style.hairColor);
  if (style.sunglassesStyle) {
    const map = { dark: '#111a22', blue: '#1e6fd9', red: '#d92b1e', yellow: '#e8b41a' };
    if (style.sunglassesStyle === 'none') {
      if (data._sunglassMeshes) data._sunglassMeshes.forEach(m => m.visible = false);
    } else {
      if (data._sunglassMeshes) data._sunglassMeshes.forEach(m => m.visible = true);
      if (map[style.sunglassesStyle] && data.materials.lens)
        data.materials.lens.color.set(map[style.sunglassesStyle]);
    }
  }
  if (style.rimDepth != null) r4SetRimDepth(data, style.rimDepth);
  if (style.hairStyle && data._hairMeshes) {
    data._hairMeshes.forEach(m => { if (m) m.visible = false; });
    if (data._hairMeshes[style.hairStyle]) data._hairMeshes[style.hairStyle].visible = true;
  }
  if (style.beardStyle && data._beardMeshes) {
    data._beardMeshes.forEach(m => { if (m) m.visible = false; });
    if (data._beardMeshes[style.beardStyle]) data._beardMeshes[style.beardStyle].visible = true;
  }
}

// ============================================================
// POSE DES JAMBES ET DES BRAS
// ============================================================
function r4PoseLegs(data, crankAngle) {
  const bb = data.bb, upper = data.upperLeg, lower = data.lowerLeg;
  data.body.updateMatrix();
  const bInv = data.body.matrix.clone().invert();
  for (const leg of data.legs) {
    const a = crankAngle + leg.phase;
    const ankle = new V3(
      leg.side * data.pedalOffset,
      bb.y - data.crankRadius * Math.sin(a),
      bb.z + data.crankRadius * Math.cos(a)
    );
    ankle.applyMatrix4(bInv);
    const hip = leg.hip;
    const h2a = new V3().subVectors(ankle, hip);
    const dist = Math.max(.0001, h2a.length());
    const dir = h2a.multiplyScalar(1 / dist);
    const usable = Math.min(dist, upper + lower - .001);
    const along = (upper * upper - lower * lower + usable * usable) / (2 * usable);
    const height = Math.sqrt(Math.max(0, upper * upper - along * along));
    const bend = new V3(leg.side * .12, .03, .62);
    bend.addScaledVector(dir, -bend.dot(dir));
    if (bend.lengthSq() < .0001) bend.set(leg.side * .8, 0, 0);
    bend.normalize();
    const knee = new V3().copy(hip).addScaledVector(dir, along).addScaledVector(bend, height);
    const shortEnd = new V3().lerpVectors(hip, knee, .72);
    const calfEnd = new V3().lerpVectors(knee, ankle, .84);
    r4Seg(leg.short, hip, shortEnd, .070);
    r4Seg(leg.thighSkin, shortEnd, knee, .054);
    r4Seg(leg.calf, knee, calfEnd, .061);
    r4Seg(leg.sock, calfEnd, ankle, .049);
    leg.shoe.position.copy(ankle);
    leg.shoe.rotation.set(.10 + .12 * Math.sin(a), 0, 0);
    leg.knee.copy(knee);
    if (leg.kneeMesh) leg.kneeMesh.position.copy(knee);
    leg.pedal.copy(ankle);
  }
}
function r4PoseArms(data) {
  data.body.updateMatrix();
  const bInv = data.body.matrix.clone().invert();
  for (const arm of data.arms) {
    const shoulder = arm.shoulder;
    const wrist = arm.grip.clone().applyMatrix4(bInv);
    const elbow = shoulder.clone().lerp(wrist, .53);
    elbow.x += arm.side * .055;
    elbow.y += .035;
    elbow.z -= .025;
    const sleeveEnd = shoulder.clone().lerp(elbow, .70);
    r4Seg(arm.sleeve, shoulder, sleeveEnd, .066);
    r4Seg(arm.upperSkin, sleeveEnd, elbow, .050);
    r4Seg(arm.forearm, elbow, wrist, .043);
    arm.shoulderJoint.position.copy(shoulder);
    arm.elbowJoint.position.copy(elbow);
    arm.wristJoint.position.copy(wrist);
    arm.glove.position.copy(wrist);
    arm.glove.rotation.z = arm.side * .18;
    arm.wrist.copy(wrist);
  }
}

// ============================================================
// CRÉATION DU CYCLISTE ET DU VÉLO
// ============================================================
function makeCyclist() {
  let g = new THREE.Group();
  g.name = 'performance-road-bike';

  const mat = (c, r, m) => new THREE.MeshStandardMaterial({
    color: c,
    roughness: r == null ? .55 : r,
    metalness: m == null ? 0 : m
  });
  const tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, false);
  const fineTubeGeo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, false);
  const calfGeo = new THREE.CylinderGeometry(.72, 1, 1, 24, 4, false);
  const addTube = (parent, a, b, r, material, geo) => {
    const mesh = new THREE.Mesh(geo || tubeGeo, material);
    parent.add(mesh);
    return r4Seg(mesh, a, b, r);
  };
  const addMesh = (parent, geo, material, pos, scale) => {
    const mesh = new THREE.Mesh(geo, material);
    if (pos) mesh.position.copy(pos);
    if (scale) mesh.scale.copy(scale);
    parent.add(mesh);
    return mesh;
  };

  // Matériaux
  const frameMat = mat(0x163e4b, .28, .68);
  const frameAccentMat = mat(0x0aa6a4, .33, .45);
  const rubberMat = mat(0x101214, .78, .02);
  const rimMat = mat(0x5b6670, .24, .82); rimMat.side = THREE.DoubleSide;
  const spokeMat = new THREE.LineBasicMaterial({ color: 0xbcc7cb, transparent: true, opacity: .86 });
  const steelMat = mat(0x8a969b, .22, .88);
  const darkMetalMat = mat(0x20262b, .3, .76);
  const chainMat = mat(0x9c8755, .28, .72);
  const skinMat = mat(0xc98a6b, .32, 0);
  const skinShadeMat = mat(0xad674f, .68, 0);
  const jerseyMat = mat(0x007d91, .48, .04);
  const sleeveMat = mat(0x075c88, .5, .04);
  const orangeMat = mat(0xf36b32, .45, .03);
  const shortMat = mat(0x13171c, .5, .1);
  const gloveMat = mat(0x171c20, .48, .15);
  const shoeMat = mat(0xe2e6e4, .48, .06);
  const sockMat = mat(0xe7ecea, .6, 0);
  const lensMat = new THREE.MeshStandardMaterial({ color: 0x0a0f14, roughness: .08, metalness: .9 });
  const helmetMat = mat(0x128f9a, .36, .18);
  const hairMat = mat(0x2e1f14, .95, 0);
  const beardMat = mat(0x2e1f14, .9, 0);

  const wheelRadius = .35;
  const rearAxle = new V3(0, wheelRadius, -.62);
  const frontAxle = new V3(0, wheelRadius, .62);
  const bb = new V3(0, .405, -.06);
  const seatJoint = new V3(0, .835, -.255);
  const headBottom = new V3(0, .72, .365);
  const headTop = new V3(0, .93, .405);

  // Roues
  const tireGeo = new THREE.TorusGeometry(.340, .013, 12, 48);
  const hubGeo = new THREE.CylinderGeometry(.027, .027, .125, 12);
  const rotorGeo = new THREE.CylinderGeometry(.115, .115, .008, 28);
  const discMat = mat(0x9aa0a6, .25, .95);
  const makeWheel = z => {
    const wheel = new THREE.Group();
    wheel.position.set(0, wheelRadius, z);
    const tire = new THREE.Mesh(tireGeo, rubberMat);
    tire.rotation.y = Math.PI / 2;
    wheel.add(tire);
    const rim = new THREE.Mesh(r4AeroRimGeometry(50), rimMat);
    wheel.add(rim);
    const hub = new THREE.Mesh(hubGeo, steelMat);
    hub.rotation.z = Math.PI / 2;
    wheel.add(hub);
    const spokes = new THREE.LineSegments(r4SpokeGeometry(50), spokeMat);
    wheel.add(spokes);
    wheel.userData = { rim, spokes };
    const caliper = new THREE.Mesh(new THREE.BoxGeometry(.035, .065, .028), darkMetalMat);
    caliper.position.set(-.062, .07, 0);
    wheel.add(caliper);
    const rotor = new THREE.Mesh(rotorGeo, discMat);
    rotor.rotation.z = Math.PI / 2;
    rotor.position.x = -.067;
    wheel.add(rotor);
    g.add(wheel);
    return wheel;
  };
  const wheels = [makeWheel(rearAxle.z), makeWheel(frontAxle.z)];

  // Cadre
  const bbShell = new THREE.Mesh(new THREE.CylinderGeometry(.045, .045, .10, 20), frameMat);
  bbShell.rotation.z = Math.PI / 2;
  bbShell.position.copy(bb);
  g.add(bbShell);
  const headTubeMesh = new THREE.Mesh(new THREE.CylinderGeometry(.032, .038, .26, 20), frameMat);
  headTubeMesh.position.set(0, .825, .385);
  headTubeMesh.rotation.x = .18;
  g.add(headTubeMesh);
  const aeroDownGeo = new THREE.CylinderGeometry(.022, .032, 1, 16);
  const aeroTopGeo = new THREE.CylinderGeometry(.018, .024, 1, 16);
  addTube(g, bb, seatJoint, .026, frameMat, fineTubeGeo);
  addTube(g, seatJoint, headTop, .023, frameMat, aeroTopGeo);
  addTube(g, bb, headBottom, .030, frameMat, aeroDownGeo);
  for (const jp of [bb, seatJoint, headTop, headBottom, rearAxle, frontAxle]) {
    const weld = new THREE.Mesh(new THREE.SphereGeometry(.038, 16, 12), frameMat);
    weld.position.copy(jp);
    g.add(weld);
  }
  for (const side of [-1, 1]) {
    addTube(g, new V3(side * .035, bb.y, bb.z), new V3(side * .035, rearAxle.y, rearAxle.z), .013, frameMat);
    addTube(g, new V3(side * .035, seatJoint.y, seatJoint.z), new V3(side * .035, rearAxle.y, rearAxle.z), .011, frameMat);
  }
  addTube(g, headBottom, headTop, .036, frameMat, fineTubeGeo);
  const forkGeo = new THREE.CylinderGeometry(.014, .020, 1, 14);
  addTube(g, new V3(-.018, headBottom.y, headBottom.z), new V3(-.047, frontAxle.y, frontAxle.z), .020, frameMat, forkGeo);
  addTube(g, new V3(.018, headBottom.y, headBottom.z), new V3(.047, frontAxle.y, frontAxle.z), .020, frameMat, forkGeo);
  addTube(g, seatJoint, new V3(0, .908, -.285), .016, frameMat, fineTubeGeo);
  const saddleRail = new THREE.Mesh(new THREE.BoxGeometry(.04, .008, .22), steelMat);
  saddleRail.position.set(0, .905, -.28);
  g.add(saddleRail);
  const saddle = addMesh(g, new THREE.BoxGeometry(.135, .022, .28), shortMat, new V3(0, .922, -.325));
  saddle.rotation.x = -.06;
  const saddleNose = addMesh(g, new THREE.BoxGeometry(.055, .018, .12), shortMat, new V3(0, .918, -.16));
  saddleNose.rotation.x = -.05;

  // Guidon
  const stemEnd = new V3(0, .985, .51);
  addTube(g, headTop, stemEnd, .022, darkMetalMat);
  addTube(g, new V3(-.20, .985, .51), new V3(.20, .985, .51), .018, darkMetalMat);
  addTube(g, new V3(-.205, .985, .51), new V3(.205, .985, .51), .015, darkMetalMat);
  for (const side of [-1, 1]) {
    const h0 = new V3(side * .205, .985, .51);
    const h1 = new V3(side * .245, .930, .505);
    const h2 = new V3(side * .245, .875, .435);
    const h3 = new V3(side * .205, .875, .370);
    addTube(g, h0, h1, .014, darkMetalMat);
    addTube(g, h1, h2, .014, darkMetalMat);
    addTube(g, h2, h3, .014, darkMetalMat);
    const hood = addMesh(g, new THREE.BoxGeometry(.055, .055, .070), gloveMat, new V3(side * .215, 1.000, .500));
    hood.rotation.y = side * .12;
  }

  // Bidons
  const cage = new THREE.Mesh(new THREE.TorusGeometry(.038, .008, 6, 16), darkMetalMat);
  cage.position.set(0, .56, .235);
  cage.rotation.x = .5;
  g.add(cage);
  const bottle = new THREE.Mesh(new THREE.CylinderGeometry(.036, .036, .16, 14), mat(0xffffff, .35, 0));
  bottle.position.set(0, .62, .245);
  bottle.rotation.x = .48;
  g.add(bottle);
  const bottleCap = new THREE.Mesh(new THREE.CylinderGeometry(.018, .018, .025, 12), frameAccentMat);
  bottleCap.position.set(0, .70, .27);
  bottleCap.rotation.x = .48;
  g.add(bottleCap);
  const bottle2 = new THREE.Mesh(new THREE.CylinderGeometry(.036, .036, .16, 14), mat(0x00a3b8, .35, 0));
  bottle2.position.set(0, .68, -.05);
  bottle2.rotation.x = -.15;
  g.add(bottle2);

  // Transmission
  for (let i = 0; i < 4; i++) {
    const cog = new THREE.Mesh(new THREE.TorusGeometry(.043 + i * .006, .004, 5, 16), steelMat);
    cog.rotation.y = Math.PI / 2;
    cog.position.set(.071 + i * .006, rearAxle.y, rearAxle.z);
    g.add(cog);
  }
  addTube(g, new V3(.094, bb.y + .075, bb.z - .02), new V3(.094, rearAxle.y + .036, rearAxle.z), .005, chainMat);
  addTube(g, new V3(.094, bb.y - .070, bb.z - .02), new V3(.094, rearAxle.y - .030, rearAxle.z), .005, chainMat);

  const crankRadius = .17;
  const cranks = new THREE.Group();
  cranks.name = 'cranks-axis-x';
  cranks.position.copy(bb);
  g.add(cranks);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.118, .012, 8, 32), chainMat);
  ring.rotation.y = Math.PI / 2;
  ring.position.x = .090;
  cranks.add(ring);
  const spider = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, .012, 16), darkMetalMat);
  spider.rotation.z = Math.PI / 2;
  spider.position.x = .09;
  cranks.add(spider);
  const pedals = [];
  for (const side of [-1, 1]) {
    addTube(cranks, new V3(side * .102, 0, 0), new V3(si
  // ═══════════════════════════════════════════════════════════
// PARTIE 3b-1 : OPENSTREETMAP + ROULER LIBRE
// ═══════════════════════════════════════════════════════════

// ============================================================
// VARIABLES OSM GLOBALES
// ============================================================
let cityEntries = [];
let cityBoundaryEvents = [];
let osmMapFeatures = [];
let osmRouteIndexCache = null;
let osmCityGroup = null;
let osmCityGroupWorld = null;
let osmLoadingToken = 0;
let osmFacadeTexture = null;
let osmTok = 0;
let roundaboutZones = [];
let sideRoadLines = [];

// Rouler libre
let freeMap = null, freeMarker = null;
let freeCenter = { lat: 49.4736, lon: -1.5125 };
let freeGraph = null, freeJunctions = null, freeNavigation = null;
let freeRadiusUsed = 2000;

// ============================================================
// UTILITAIRES OSM
// ============================================================
function osmPublishSceneryData() {
  if (typeof window !== 'undefined') {
    window.cityEntries = cityEntries;
    window.cityBoundaryEvents = cityBoundaryEvents;
    window.osmMapFeatures = osmMapFeatures;
  }
}
function osmDisposeObject(root) {
  if (!root || !root.traverse) return;
  root.traverse(o => {
    if (o.geometry && o.geometry.dispose) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    mats.forEach(m => {
      if (m && m.map && m.map.dispose) m.map.dispose();
      if (m && m.dispose) m.dispose();
    });
  });
}
function resetSceneryData() {
  cityEntries = [];
  cityBoundaryEvents = [];
  osmMapFeatures = [];
  roundaboutZones = [];
  sideRoadLines = [];
  if (osmCityGroup) {
    if (osmCityGroupWorld && osmCityGroupWorld.remove) osmCityGroupWorld.remove(osmCityGroup);
    osmDisposeObject(osmCityGroup);
  }
  osmCityGroup = null;
  osmCityGroupWorld = null;
  osmPublishSceneryData();
}
function osmSleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function osmCurrent(tok, target) { return tok === osmTok && world === target; }
function osmSetStartEnabled(enabled) {
  try { const b = $('go'); if (b) b.disabled = !enabled; } catch (_) {}
}
function osmSetSkipVisible(visible) {
  try {
    const btn = $('skipScenery');
    if (!btn) return;
    btn.hidden = !visible;
    btn.classList.toggle('hide', !visible);
    btn.setAttribute('aria-hidden', visible ? 'false' : 'true');
  } catch (_) {}
}
function osmStopIfStale(token, target) {
  if (osmCurrent(token, target)) return false;
  if (osmLoadingToken === token && world === target) {
    osmLoadingToken = 0;
    osmSetSkipVisible(false);
  }
  return true;
}
function osmFinishLoading(token) {
  if (osmLoadingToken === token) {
    osmLoadingToken = 0;
    osmSetSkipVisible(false);
  }
}
function osmToast(message) { if (typeof toast === 'function') toast(message); }
function osmProgress(value, message) { if (typeof prog === 'function') prog(value, message); }

// ============================================================
// OVERPASS API (POST, fallback sur 3 serveurs)
// ============================================================
const OSM_SERVERS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter'
];
const OSM_CHUNK_METRES = 1500;
const OSM_ROUTE_CAP_METRES = 25000;
const OSM_ROUTE_GRID_METRES = 120;

async function osmPost(url, query, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'data=' + encodeURIComponent(query),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error('HTTP ' + response.status + (text ? ' — ' + text.slice(0, 120).replace(/\s+/g, ' ') : ''));
    try { return JSON.parse(text); }
    catch (_) { throw new Error('JSON invalide' + (text ? ' — ' + text.slice(0, 120).replace(/\s+/g, ' ') : '')); }
  } catch (error) {
    throw new Error(
      error && error.name === 'AbortError'
        ? 'délai dépassé'
        : (error && error.message) || 'erreur réseau/CORS'
    );
  } finally {
    clearTimeout(timer);
  }
}
async function osmProbeServers() {
  const results = await Promise.all(OSM_SERVERS.map(async url => {
    const t0 = performance.now();
    try {
      await osmPost(url, '[out:json][timeout:5];node(1);out;', 8000);
      return { url, ms: performance.now() - t0 };
    } catch (error) {
      return { url, error: error.message };
    }
  }));
  return {
    results,
    live: results.filter(r => !r.error).sort((a, b) => a.ms - b.ms).map(r => r.url)
  };
}
async function osmAsk(query, servers) {
  let lastError = '';
  for (let i = 0; i < servers.length; i++) {
    try { return await osmPost(servers[i], query, 22000); }
    catch (error) {
      lastError = error.message;
      if (i < servers.length - 1) await osmSleep(400 * (i + 1));
    }
  }
  throw new Error(lastError || 'aucun serveur Overpass disponible');
}

// ============================================================
// INDEX ROUTE (recherche rapide du point le plus proche)
// ============================================================
function osmElementKey(element) {
  return String(element && element.type || 'unknown') + '/' + String(element && element.id);
}
function osmXY(point) {
  if (!point || point.lon == null || point.lat == null || !proj) return null;
  return [(point.lon - proj.lo) * proj.kx, -(point.lat - proj.la) * proj.kz];
}
function osmElementPoints(element) {
  if (!element) return [];
  const geometry = Array.isArray(element.geometry) ? element.geometry : [];
  const points = geometry.map(osmXY).filter(Boolean);
  if (points.length) return points;
  const one = osmXY(element);
  return one ? [one] : [];
}
function osmClosed(points) {
  if (!points || points.length < 4) return false;
  const a = points[0], b = points[points.length - 1];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < .05;
}
function osmCopyPoints(points) { return points.map(p => [p[0], p[1]]); }

function osmRouteIndex() {
  if (!route) return null;
  if (osmRouteIndexCache && osmRouteIndexCache.route === route && osmRouteIndexCache.n === route.n)
    return osmRouteIndexCache;
  const cells = new Map(), { X, Y, Z, n } = route;
  const cell = OSM_ROUTE_GRID_METRES;
  const add = (gx, gz, index) => {
    const key = gx + ',' + gz;
    let bucket = cells.get(key);
    if (!bucket) { bucket = []; cells.set(key, bucket); }
    bucket.push(index);
  };
  for (let i = 0; i < n; i++) {
    const x0 = X[i], z0 = Z[i], x1 = X[i + 1], z1 = Z[i + 1];
    const gx0 = Math.floor(Math.min(x0, x1) / cell), gx1 = Math.floor(Math.max(x0, x1) / cell);
    const gz0 = Math.floor(Math.min(z0, z1) / cell), gz1 = Math.floor(Math.max(z0, z1) / cell);
    for (let gx = gx0; gx <= gx1; gx++)
      for (let gz = gz0; gz <= gz1; gz++) add(gx, gz, i);
  }
  osmRouteIndexCache = { route, n, cells, cell };
  return osmRouteIndexCache;
}

function nearestOnRoute(x, z) {
  const index = osmRouteIndex();
  if (!index || !route || route.n < 1) return null;
  const { X, Y, Z, n } = route;
  const cell = index.cell, cx = Math.floor(x / cell), cz = Math.floor(z / cell);
  let best = null;
  const visit = i => {
    const ax = X[i], az = Z[i], bx = X[i + 1], bz = Z[i + 1];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const px = ax + dx * t, pz = az + dz * t;
    const dist2 = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (!best || dist2 < best.dist2) {
      const l = Math.sqrt(l2) || 1;
      best = {
        x: px, y: Y[i] + (Y[i + 1] - Y[i]) * t, z: pz,
        distance: Math.min(route.len, (i + t) * (route.step || ST)),
        dist2, tx: dx / l, tz: dz / l
      };
    }
  };
  const visited = new Set();
  for (let ring = 0; ring <= 18; ring++) {
    for (let gx = cx - ring; gx <= cx + ring; gx++) {
      for (let gz = cz - ring; gz <= cz + ring; gz++) {
        if (ring && gx !== cx - ring && gx !== cx + ring && gz !== cz - ring && gz !== cz + ring) continue;
        const bucket = index.cells.get(gx + ',' + gz);
        if (bucket) for (const i of bucket)
          if (!visited.has(i)) { visited.add(i); visit(i); }
      }
    }
    if (best && ring >= 2 && best.dist2 < ((ring - 1) * cell) * ((ring - 1) * cell)) break;
  }
  if (!best) {
    const stride = Math.max(1, Math.ceil(n / 1800));
    for (let i = 0; i < n; i += stride) visit(i);
  }
  return best;
}

// ============================================================
// PARSING TAGS OSM (largeur, hauteur, direction)
// ============================================================
function osmMetres(value, fallback, minimum, maximum) {
  if (value == null || value === '') return fallback;
  const text = String(value).trim().toLowerCase().replace(',', '.');
  const number = parseFloat(text);
  if (!isFinite(number)) return fallback;
  let metres = number;
  if (/\b(km|kilomet)/.test(text)) metres *= 1000;
  else if (/\b(cm|centimet)/.test(text)) metres *= .01;
  else if (/\b(mm|millimet)/.test(text)) metres *= .001;
  else if (/\b(ft|feet|foot)\b|['′]/.test(text)) metres *= .3048;
  else if (/\b(in|inch)\b|[″]/.test(text)) metres *= .0254;
  return Math.max(minimum, Math.min(maximum, metres));
}
function osmDirectionVector(value) {
  if (value == null) return null;
  const text = String(value).trim().toUpperCase();
  if (!text) return null;
  const cardinals = {
    N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
    S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
    NORTH: 0, NORTHEAST: 45, EAST: 90, SOUTHEAST: 135, SOUTH: 180,
    SOUTHWEST: 225, WEST: 270, NORTHWEST: 315,
    NORD: 0, EST: 90, SUD: 180, OUEST: 270
  };
  let degrees = cardinals[text];
  if (degrees == null) {
    const match = /^(-?\d+(?:\.\d+)?)\s*(?:°|DEG(?:REES)?)?$/.exec(text);
    if (!match) return null;
    degrees = +match[1];
  }
  const radians = ((degrees % 360) + 360) % 360 * Math.PI / 180;
  return { x: Math.sin(radians), z: -Math.cos(radians) };
}

// ============================================================
// RENDU : BÂTIMENTS
// ============================================================
const OSM_FACADE_COLOURS = [0xe8dfcf, 0xd9cdb6, 0xcfc6b8, 0xf2ede3, 0xc2b8a6];
const OSM_ROOF_COLOURS = [0x4a4f57, 0x5b5f66, 0x9a4b34, 0x7a3f2e, 0x6a6d72];
const OSM_DOOR_FRAME = new THREE.Color(0xece7dd);
const OSM_DOOR_COLOURS = [0x5b3a29, 0x3f5c4e, 0x7a1f1f, 0x3b4a6b, 0x2b2b2b];

function facade() {
  if (osmFacadeTexture) return osmFacadeTexture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#3d4a57';
  g.fillRect(52, 34, 24, 60);
  g.fillStyle = '#fff';
  g.fillRect(62, 34, 3, 60);
  g.fillRect(52, 62, 24, 3);
  g.strokeStyle = '#ece7dd';
  g.lineWidth = 4;
  g.strokeRect(50, 32, 28, 64);
  g.fillStyle = '#7d8a95';
  g.fillRect(36, 34, 12, 60);
  g.fillRect(80, 34, 12, 60);
  g.fillStyle = 'rgba(0,0,0,.1)';
  g.fillRect(0, 120, 128, 8);
  osmFacadeTexture = new THREE.CanvasTexture(canvas);
  osmFacadeTexture.wrapS = osmFacadeTexture.wrapT = THREE.RepeatWrapping;
  osmFacadeTexture.anisotropy = 4;
  return osmFacadeTexture;
}

function buildings(buildingParts, targetWorld) {
  const list = [];
  for (const [raw, tags] of buildingParts) {
    const closed = osmClosed(raw);
    const points = closed ? raw.slice(0, -1) : raw;
    if (points.length < 3) continue;
    const near = nearestOnRoute(points[0][0], points[0][1]);
    list.push({
      points, tags,
      y: (near ? near.y : 0) - .4,
      d: near ? near.dist2 : Infinity
    });
  }
  list.sort((a, b) => a.d - b.d);
  const wallPositions = [], wallUVs = [], wallColours = [];
  const roofPositions = [], roofColours = [];
  const doorPositions = [], doorColours = [];
  let count = 0, seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const wall = (P, UV, colour) => {
    for (let k = 0; k < 3; k++) {
      wallPositions.push(P[k][0], P[k][1], P[k][2]);
      wallUVs.push(UV[k][0], UV[k][1]);
      wallColours.push(colour.r, colour.g, colour.b);
    }
  };
  const roof = (P, colour) => {
    for (let k = 0; k < 3; k++) {
      roofPositions.push(P[k][0], P[k][1], P[k][2]);
      roofColours.push(colour.r, colour.g, colour.b);
    }
  };
  const door = (P, colour) => {
    for (const v of P) {
      doorPositions.push(v[0], v[1], v[2]);
      doorColours.push(colour.r, colour.g, colour.b);
    }
  };

  for (const item of list.slice(0, 1500)) {
    const c = item.points, t = item.tags, y = item.y, m = c.length;
    let area = 0;
    for (let i = 0; i < m; i++) {
      const a = c[i], b = c[(i + 1) % m];
      area += a[0] * b[1] - b[0] * a[1];
    }
    const orientation = area > 0 ? 1 : -1;
    area = Math.abs(area) / 2;
    if (area < 8) continue;
    const kind = t.building || 'yes';
    const facadeColour = new THREE.Color(OSM_FACADE_COLOURS[Math.floor(random() * OSM_FACADE_COLOURS.length)]);
    const roofColour = new THREE.Color(OSM_ROOF_COLOURS[Math.floor(random() * OSM_ROOF_COLOURS.length)]);
    let gable = null, roofHeight = 0;
    if (m === 4 && area > 25 && area < 600 && t['roof:shape'] !== 'flat' &&
        !/^(industrial|warehouse|commercial|retail|garage|garages|carport|greenhouse)$/.test(kind)) {
      const edges = [0, 1, 2, 3].map(i => {
        const a = c[i], b = c[(i + 1) % 4];
        return [b[0] - a[0], b[1] - a[1]];
      });
      const lengths = edges.map(v => Math.hypot(v[0], v[1]));
      const rectangular = [0, 1, 2, 3].every(i => {
        const a = edges[i], b = edges[(i + 1) % 4];
        return Math.abs((a[0] * b[0] + a[1] * b[1]) / ((lengths[i] * lengths[(i + 1) % 4]) || 1)) < .35;
      });
      if (rectangular) {
        gable = lengths[0] >= lengths[1] ? [c[0], c[1], c[2], c[3]] : [c[1], c[2], c[3], c[0]];
        roofHeight = Math.min(Math.min(lengths[0], lengths[1]) * .39, 5.5);
      }
    }
    const levels = parseFloat(t['building:levels']);
    const mappedHeight = osmMetres(t.height, NaN, 2.5, 120);
    const height = isFinite(mappedHeight)
      ? Math.max(2.5, mappedHeight - roofHeight)
      : isFinite(levels) ? levels * 3
      : /^(garage|garages|shed|carport|hut|cabin|service|kiosk)$/.test(kind) ? 2.8
      : /^(barn|farm_auxiliary|greenhouse|stable|cowshed)$/.test(kind) ? 4.5
      : /^(church|cathedral|chapel)$/.test(kind) ? 9
      : area > 1200 ? 7 : 5.5;
    const y0 = y - 1.5, y1 = y + height;
    let longest = -1, longestLength = 0;
    for (let i = 0; i < m; i++) {
      const a = c[i], b = c[(i + 1) % m];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < .3) continue;
      if (length > longestLength) { longestLength = length; longest = i; }
      const u = length < 2.5 ? .15 : Math.max(1, Math.round(length / 7));
      const bottom = -.5, top = height / 3;
      wall([[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]]],
           [[0, bottom], [u, bottom], [u, top]], facadeColour);
      wall([[a[0], y0, a[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]],
           [[0, bottom], [u, top], [0, top]], facadeColour);
    }
    if (longest >= 0 && longestLength >= 4.5 && height >= 2.6 &&
        !/^(garage|garages|shed|carport|greenhouse|hut|cabin|service|kiosk|barn|stable|cowshed|farm_auxiliary|roof)$/.test(kind)) {
      const a = c[longest], b = c[(longest + 1) % m];
      const dx = (b[0] - a[0]) / longestLength, dz = (b[1] - a[1]) / longestLength;
      const nx = dz * orientation, nz = -dx * orientation;
      const slots = Math.max(1, Math.round(longestLength / 7));
      const atSlot = slots >= 2 ? Math.floor(slots / 2) / slots : (random() < .5 ? .25 : .75);
      const cx = a[0] + (b[0] - a[0]) * atSlot;
      const cz = a[1] + (b[1] - a[1]) * atSlot;
      const quad = (halfWidth, quadHeight, offset, colour) => {
        const P = [[-halfWidth, 0], [halfWidth, 0], [halfWidth, quadHeight], [-halfWidth, quadHeight]]
          .map(([s, vv]) => [cx + dx * s + nx * offset, y + .02 + vv, cz + dz * s + nz * offset]);
        door([P[0], P[1], P[2]], colour);
        door([P[0], P[2], P[3]], colour);
      };
      quad(.62, 2.25, .04, OSM_DOOR_FRAME);
      quad(.5, 2.1, .07, new THREE.Color(OSM_DOOR_COLOURS[Math.floor(random() * OSM_DOOR_COLOURS.length)]));
    }
    if (gable) {
      const P = p => [p[0], y1, p[1]];
      const middle12 = [(gable[1][0] + gable[2][0]) / 2, y1 + roofHeight, (gable[1][1] + gable[2][1]) / 2];
      const middle30 = [(gable[3][0] + gable[0][0]) / 2, y1 + roofHeight, (gable[3][1] + gable[0][1]) / 2];
      roof([P(gable[0]), P(gable[1]), middle12], roofColour);
      roof([P(gable[0]), middle12, middle30], roofColour);
      roof([P(gable[2]), P(gable[3]), middle30], roofColour);
      roof([P(gable[2]), middle30, middle12], roofColour);
      wall([P(gable[1]), P(gable[2]), middle12], [[0, 0], [1, 0], [.5, .5]], facadeColour);
      wall([P(gable[3]), P(gable[0]), middle30], [[0, 0], [1, 0], [.5, .5]], facadeColour);
    } else {
      try {
        const vectors = c.map(p => new THREE.Vector2(p[0], p[1]));
        const flatColour = new THREE.Color(0x8d9094);
        for (const face of THREE.ShapeUtils.triangulateShape(vectors, []))
          roof(face.map(i => [c[i][0], y1 + .05, c[i][1]]), flatColour);
      } catch (_) {}
    }
    count++;
  }
  const mesh = (positions, colours, uvs, material) => {
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    if (uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    targetWorld.add(new THREE.Mesh(geometry, material));
  };
  mesh(wallPositions, wallColours, wallUVs, new THREE.MeshLambertMaterial({ map: facade(), vertexColors: true, side: THREE.DoubleSide }));
  mesh(roofPositions, roofColours, null, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh(doorPositions, doorColours, null, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  return count;
}

// ============================================================
// RENDU : HAIES
// ============================================================
function osmSampleLine(points, spacing) {
  const sampled = [];
  if (!points.length) return sampled;
  sampled.push([points[0][0], points[0][1]]);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < .05) continue;
    for (let d = spacing; d < length; d += spacing)
      sampled.push([a[0] + (b[0] - a[0]) * d / length, a[1] + (b[1] - a[1]) * d / length]);
    sampled.push([b[0], b[1]]);
  }
  return sampled;
}
function osmNoise(x, z) { return (Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1; }

function hedges(hedgeParts, targetWorld) {
  const sorted = hedgeParts.map(([points, tags]) => {
    const near = nearestOnRoute(points[0][0], points[0][1]);
    return { points, tags, d: near ? near.dist2 : Infinity, estimated: tags.source === 'estimated' };
  }).sort((a, b) => a.d - b.d).slice(0, 1800);
  const groups = { mapped: { base: [], leaves: [] }, estimated: { base: [], leaves: [] } };
  let mapped = 0, estimated = 0;
  const tri = (out, a, b, c) => out.push(...a, ...b, ...c);
  for (const item of sorted) {
    const height = osmMetres(item.tags.height, 2.6, .8, 7.5);  
        const width = osmMetres(item.tags.width, 1.6, .4, 5.5);
    const line = osmSampleLine(item.points, 3);
    if (line.length < 2) continue;
    const strip = [];
    for (let i = 0; i < line.length; i++) {
      const prev = line[Math.max(0, i - 1)];
      const next = line[Math.min(line.length - 1, i + 1)];
      const dx = next[0] - prev[0], dz = next[1] - prev[1];
      const length = Math.hypot(dx, dz) || 1;
      const near = nearestOnRoute(line[i][0], line[i][1]);
      if (!near || near.dist2 > 220 * 220) { strip.push(null); continue; }
      const nx = -dz / length * width * .5;
      const nz = dx / length * width * .5;
      const y = near.y - .38;
      strip.push({
        l: [line[i][0] + nx, y, line[i][1] + nz],
        r: [line[i][0] - nx, y, line[i][1] - nz],
        lt: [line[i][0] + nx, y + height * .28, line[i][1] + nz],
        rt: [line[i][0] - nx, y + height * .28, line[i][1] - nz],
        x: line[i][0], z: line[i][1], y
      });
    }
    const group = groups[item.estimated ? 'estimated' : 'mapped'];
    let used = false;
    for (let i = 1; i < strip.length; i++) {
      const a = strip[i - 1], b = strip[i];
      if (!a || !b) continue;
      tri(group.base, a.l, b.l, b.lt);
      tri(group.base, a.l, b.lt, a.lt);
      tri(group.base, a.r, b.rt, b.r);
      tri(group.base, a.r, a.rt, b.rt);
      tri(group.base, a.lt, b.lt, b.rt);
      tri(group.base, a.lt, b.rt, a.rt);
      used = true;
    }
    if (used) {
      if (item.estimated) estimated++; else mapped++;
      for (const point of strip)
        if (point && group.leaves.length < 6500)
          group.leaves.push({ point, height, width });
    }
  }
  for (const [type, group] of Object.entries(groups)) {
    if (group.base.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(group.base, 3));
      geometry.computeVertexNormals();
      targetWorld.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: type === 'estimated' ? 0x3a5a28 : 0x1e4d22,
        roughness: .95, side: THREE.DoubleSide
      })));
    }
    if (group.leaves.length) {
      const geometry = new THREE.SphereGeometry(.85, 10, 8);
      const material = new THREE.MeshStandardMaterial({
        color: type === 'estimated' ? 0x5a8a3a : 0x2f7a2e,
        roughness: .9
      });
      const instances = new THREE.InstancedMesh(geometry, material, group.leaves.length);
      const matrix = new THREE.Matrix4();
      group.leaves.forEach(({ point, height, width }, i) => {
        const variation = Math.max(0, osmNoise(point.x, point.z));
        const sx = Math.max(.7, width * .85) * (.7 + variation * .75);
        const sy = .45 + Math.min(1.7, height * .30) + variation * .5;
        const sz = 1.0 + variation * 1.1;
        matrix.makeScale(sx, sy, sz);
        matrix.setPosition(
          point.x + (variation - .5) * .8,
          point.y + height * .72 + variation * .35,
          point.z + (variation - .5) * .8
        );
        instances.setMatrixAt(i, matrix);
      });
      instances.instanceMatrix.needsUpdate = true;
      targetWorld.add(instances);
    }
  }
  return { mapped, estimated };
}
// FIN DU MORCEAU 1
    // ============================================================
// VOIRIE SECONDAIRE + HAINES RURALES ESTIMÉES
// ============================================================
function osmDistancePointSegment(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const den = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / den));
  return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
}
function osmPointNearBuilding(x, z, buildingsList, limit) {
  for (const b of buildingsList) {
    const dx = Math.max(0, b.minX - x, x - b.maxX);
    const dz = Math.max(0, b.minZ - z, z - b.maxZ);
    if (dx * dx + dz * dz > limit * limit) continue;
    if (osmClosed(b.points) && osmPointInPolygon(b.points, x, z)) return true;
    for (let i = 1; i < b.points.length; i++)
      if (osmDistancePointSegment(x, z, b.points[i - 1], b.points[i]) < limit) return true;
  }
  return false;
}
function osmPointNearPolygon(x, z, polygons, limit) {
  for (const points of polygons) {
    if (osmClosed(points) && osmPointInPolygon(points, x, z)) return true;
    for (let i = 1; i < points.length; i++)
      if (osmDistancePointSegment(x, z, points[i - 1], points[i]) < limit) return true;
  }
  return false;
}
function estimateRuralHedges(buildingsList, hedgeList, residentialAreas, localities) {
  if (!route) return [];
  const blockers = buildingsList.map(([points]) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
    }
    return { points, minX, maxX, minZ, maxZ };
  });
  const hedgeBlockers = hedgeList.map(([line]) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of line) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
    }
    return { line, minX, maxX, minZ, maxZ };
  });
  const limit = Math.min(route.len, 25000), spacing = 12;
  const lines = [[], []], ways = [];
  for (let d = 18; d < limit - 8; d += spacing) {
    const p = at(d), a = at(Math.max(0, d - 3)), b = at(Math.min(route.len, d + 3));
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const length = Math.hypot(dx, dz) || 1;
    const tx = dx / length, tz = dz / length;
    for (let index = 0; index < 2; index++) {
      const side = index === 0 ? -1 : 1;
      const nx = tz * side, nz = -tx * side;
      const x = p[0] + nx * 5.6, z = p[2] + nz * 5.6;
      let blocked = localities.some(place => Math.hypot(place.x - x, place.z - z) < 180)
        || inRoundabout(x, z) || inSideRoad(x, z);
      if (!blocked && osmPointNearPolygon(x, z, residentialAreas, 14)) blocked = true;
      if (!blocked && osmPointNearBuilding(x, z, blockers, 16)) blocked = true;
      if (!blocked && hedgeBlockers.some(({ line, minX, maxX, minZ, maxZ }) => {
        const dx = Math.max(0, minX - x, x - maxX);
        const dz = Math.max(0, minZ - z, z - maxZ);
        if (dx * dx + dz * dz >= 49) return false;
        for (let i = 1; i < line.length; i++)
          if (osmDistancePointSegment(x, z, line[i - 1], line[i]) < 7) return true;
        return false;
      })) blocked = true;
      const run = lines[index];
      if (blocked) {
        if (run.length > 1) ways.push([run, { source: 'estimated', height: '2.4 m', width: '1.4 m' }]);
        lines[index] = [];
      } else {
        const prev = run[run.length - 1];
        if (prev && Math.hypot(prev[0] - x, prev[1] - z) > 20) {
          if (run.length > 1) ways.push([run, { source: 'estimated', height: '2.4 m', width: '1.4 m' }]);
          lines[index] = [];
        }
        lines[index].push([x, z]);
      }
    }
  }
  for (const run of lines)
    if (run.length > 1) ways.push([run, { source: 'estimated', height: '2.4 m', width: '1.4 m' }]);
  return ways;
}
function osmRoadWidth(tags) {
  const mapped = osmMetres(tags.width, NaN, 1.5, 20);
  if (isFinite(mapped)) return Math.min(8, mapped * .5);
  const type = String(tags.highway || '').toLowerCase();
  if (/motorway|trunk|primary/.test(type)) return 3.5;
  if (/secondary|tertiary/.test(type)) return 3;
  if (/service|living_street|residential|unclassified/.test(type)) return 2.15;
  if (/track/.test(type)) return 1.7;
  if (/path|footway|cycleway/.test(type)) return 1.05;
  return 2.4;
}
function selectRoadsForScene(roadParts, maxWays = 1200) {
  if (!route) return [];
  const limit = Math.min(route.len, 25000);
  const binSize = 500;
  const binCount = Math.max(1, Math.ceil(limit / binSize));
  const bins = Array.from({ length: binCount }, () => new Map());
  roadParts.forEach(([raw, tags], index) => {
    if (raw.length < 2) return;
    let total = 0;
    for (let i = 1; i < raw.length; i++) total += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
    const sampled = osmSampleLine(raw, Math.max(12, total / 60));
    const bestByBin = new Map();
    for (const point of sampled) {
      const site = nearestOnRoute(point[0], point[1]);
      if (!site || site.dist2 > 190 * 190 || site.distance > limit) continue;
      const bin = Math.min(binCount - 1, Math.floor(site.distance / binSize));
      const previous = bestByBin.get(bin);
      if (!previous || site.dist2 < previous) bestByBin.set(bin, site.dist2);
    }
    for (const [bin, distance2] of bestByBin) bins[bin].set(index, distance2);
  });
  const selected = new Set();
  const quota = Math.max(1, Math.floor(maxWays / binCount));
  for (const bin of bins)
    for (const [index] of [...bin.entries()].sort((a, b) => a[1] - b[1]).slice(0, quota))
      selected.add(index);
  if (selected.size < maxWays) {
    const remaining = [];
    bins.forEach(bin => bin.forEach((distance2, index) => {
      if (!selected.has(index)) remaining.push([index, distance2]);
    }));
    remaining.sort((a, b) => a[1] - b[1]);
    for (const [index] of remaining) {
      if (selected.size >= maxWays) break;
      selected.add(index);
    }
  }
  return [...selected].map(index => roadParts[index]);
}
function buildRoadNetwork(roadParts, targetWorld) {
  const surface = [], islands = [];
  let drawn = 0, roundabouts = 0;
  for (const [raw, tags] of roadParts) {
    if (raw.length < 2) continue;
    const half = osmRoadWidth(tags);
    const points = osmSampleLine(raw, 5);
    const centres = [];
    for (const point of points) {
      const near = nearestOnRoute(point[0], point[1]);
      centres.push(!near || near.dist2 > 190 * 190 ? null : { x: point[0], z: point[1], y: near.y + .035 });
    }
    let used = false;
    for (let i = 1; i < centres.length; i++) {
      const a = centres[i - 1], b = centres[i];
      if (!a || !b) continue;
      const prev = centres[Math.max(0, i - 2)] || a;
      const next = centres[Math.min(centres.length - 1, i + 1)] || b;
      const dx = next.x - prev.x, dz = next.z - prev.z;
      const length = Math.hypot(dx, dz) || 1;
      const nx = -dz / length, nz = dx / length;
      const al = [a.x + nx * half, a.y, a.z + nz * half];
      const ar = [a.x - nx * half, a.y, a.z - nz * half];
      const bl = [b.x + nx * half, b.y, b.z + nz * half];
      const br = [b.x - nx * half, b.y, b.z - nz * half];
      surface.push(...al, ...ar, ...br, ...al, ...br, ...bl);
      used = true;
    }
    if (used) drawn++;
    if (String(tags.junction || '').toLowerCase() === 'roundabout' && osmClosed(raw)) {
      const ring = raw.slice(0, -1);
      if (ring.length >= 8) {
        const cx = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
        const cz = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
        const near = nearestOnRoute(cx, cz);
        const radius = ring.reduce((sum, p) => sum + Math.hypot(p[0] - cx, p[1] - cz), 0) / ring.length;
        const inner = radius - half * .95;
        if (near && near.dist2 < 190 * 190 && inner > 1) {
          const center = [cx, near.y - .055, cz];
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            islands.push(...center,
              a[0], near.y - .055, a[1],
              b[0], near.y - .055, b[1]);
          }
          roundabouts++;
        }
      }
    }
  }
  if (surface.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(surface, 3));
    geometry.computeVertexNormals();
    targetWorld.add(new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: 0x5e6460, side: THREE.DoubleSide })));
  }
  if (islands.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(islands, 3));
    geometry.computeVertexNormals();
    targetWorld.add(new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: 0x789054, side: THREE.DoubleSide })));
  }
  return { drawn, roundabouts };
}
function collectRoundaboutZones(roads) {
  roundaboutZones = [];
  for (const [raw, tags] of roads || []) {
    if (String(tags.junction || '').toLowerCase() !== 'roundabout' || !osmClosed(raw)) continue;
    const ring = raw.slice(0, -1);
    if (ring.length < 8) continue;
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const r = ring.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cz), 0) / ring.length;
    roundaboutZones.push({ x: cx, z: cz, r: r + 9 });
  }
}
function inRoundabout(x, z) { return roundaboutZones.some(z0 => Math.hypot(x - z0.x, z - z0.z) < z0.r); }
function inSideRoad(x, z) {
  for (const line of sideRoadLines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const den = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / den));
      if (Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t) < 4.2) return true;
    }
  }
  return false;
}
function osmPointInPolygon(points, x, z) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / ((b[1] - a[1]) || 1e-12) + a[0])
      inside = !inside;
  }
  return inside;
}
function osmCanvasForTown(name, estimated, demo) {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 278;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = '#d5232f';
  g.lineWidth = 18;
  g.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);
  const label = String(name || 'DEMO').trim().toUpperCase();
  let size = 76;
  do {
    g.font = '700 ' + size + 'px Arial, sans-serif';
    size -= 2;
  } while (g.measureText(label).width > 560 && size > 30);
  g.fillStyle = '#101010';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 320, (estimated || demo) ? 112 : 139);
  if (estimated || demo) {
    g.font = '600 29px Arial, sans-serif';
    g.fillStyle = '#4a4a4a';
    g.fillText(estimated ? 'entrée estimée' : 'DEMO', 320, 203);
  }
  const texture = new THREE.CanvasTexture(canvas);
  if ('colorSpace' in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
function createTownSign(entry, targetWorld) {
  const target = targetWorld || world;
  if (!target || !entry || !THREE) return null;
  if (!osmCityGroup || osmCityGroupWorld !== target) {
    if (osmCityGroup && osmCityGroupWorld && osmCityGroupWorld.remove) osmCityGroupWorld.remove(osmCityGroup);
    osmCityGroup = new THREE.Group();
    osmCityGroup.name = 'osm-town-signs';
    osmCityGroupWorld = target;
    target.add(osmCityGroup);
  }
  const near = nearestOnRoute(entry.x, entry.z);
  const tx = entry.tx || entry.dirX || (near && near.tx) || 0;
  const tz = entry.tz || entry.dirZ || (near && near.tz) || 1;
  const length = Math.hypot(tx, tz) || 1;
  const fx = tx / length, fz = tz / length;
  const root = new THREE.Group();
  root.name = 'osm-town-sign';
  root.rotation.y = Math.atan2(fx, fz);
  let sx = entry.x, sz = entry.z;
  const routeX = near ? near.x : entry.x;
  const routeZ = near ? near.z : entry.z;
  const lateral = (sx - routeX) * fz - (sz - routeZ) * fx;
  if (Math.abs(lateral) < 4.85) {
    const side = lateral < -.8 ? -1 : 1;
    sx = routeX + fz * 4.85 * side;
    sz = routeZ - fx * 4.85 * side;
  }
  root.position.set(sx, (entry.y != null ? entry.y : (near && near.y) || 0) - .35, sz);
  root.userData = { distance: entry.distance, name: entry.name, source: entry.source };
  const postMaterial = new THREE.MeshLambertMaterial({ color: 0x6d6d6d });
  const postGeometry = new THREE.CylinderGeometry(.045, .045, 2.65, 8);
  for (const x of [-.9, .9]) {
    const post = new THREE.Mesh(postGeometry, postMaterial);
    post.position.set(x, 1.325, 0);
    root.add(post);
  }
  const texture = osmCanvasForTown(entry.name, entry.source === 'estimated', entry.source === 'demo');
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(2.65, 1.15),
    new THREE.MeshLambertMaterial({ map: texture, side: THREE.FrontSide })
  );
  board.position.set(0, 2.5, 0);
  board.rotation.y = Math.PI;
  root.add(board);
  osmCityGroup.add(root);
  return root;
}
// FIN DU MORCEAU 2
    // ============================================================
// ENTRÉES VILLAGE (panneaux OSM + polygones)
// ============================================================
function osmNormalisedName(name) {
  return String(name || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}
function osmPushBoundaryEvent(event) {
  if (!event || !event.name || !Number.isFinite(event.distance)) return false;
  const name = osmNormalisedName(event.name);
  if (cityBoundaryEvents.some(o =>
    o.type === event.type &&
    osmNormalisedName(o.name) === name &&
    Math.abs(o.distance - event.distance) < 500
  )) return false;
  cityBoundaryEvents.push(event);
  cityBoundaryEvents.sort((a, b) => a.distance - b.distance);
  osmPublishSceneryData();
  return true;
}
function osmPushCityEntry(entry) {
  const key = osmNormalisedName(entry.name);
  if (!key) return false;
  if (cityEntries.some(o =>
    osmNormalisedName(o.name) === key &&
    Math.abs(o.distance - entry.distance) < 300
  )) return false;
  cityEntries.push(entry);
  cityEntries.sort((a, b) => a.distance - b.distance);
  osmPushBoundaryEvent({ ...entry, type: 'entry' });
  osmPublishSceneryData();
  return true;
}
function osmNearestLocality(x, z, localities, maxDistance) {
  let chosen = null, best = (maxDistance || Infinity) * (maxDistance || Infinity);
  for (const locality of localities) {
    const d2 = (x - locality.x) * (x - locality.x) + (z - locality.z) * (z - locality.z);
    if (d2 < best) { best = d2; chosen = locality; }
  }
  return chosen;
}
function makeTownEntries(elements, targetWorld) {
  const localities = [], signs = [], polygons = [];
  for (const element of elements || []) {
    const tags = element.tags || {};
    const points = osmElementPoints(element);
    if (!points.length) continue;
    const place = String(tags.place || '').toLowerCase();
    if (element.type === 'node' && /^(city|town|village)$/.test(place) && String(tags.name || '').trim()) {
      localities.push({
        name: String(tags.name).trim(),
        place,
        x: points[0][0],
        z: points[0][1]
      });
    }
    if (tags.traffic_sign || tags['traffic_sign:forward'] || tags['traffic_sign:backward'])
      signs.push({ element, tags, points });
    if (osmClosed(points) && (/^(city|town|village)$/.test(place) || tags.landuse === 'residential'))
      polygons.push({ tags, points, place });
  }
  for (const sign of signs) {
    const initial = sign.points.length > 1
      ? { x: sign.points[1][0] - sign.points[0][0], z: sign.points[1][1] - sign.points[0][1] }
      : null;
    if (initial) {
      const l = Math.hypot(initial.x, initial.z) || 1;
      initial.x /= l; initial.z /= l;
    }
    let best = null;
    const tryPoint = (x, z, wd) => {
      const near = nearestOnRoute(x, z);
      if (near && (!best || near.dist2 < best.near.dist2)) best = { x, z, near, wayDirection: wd };
    };
    tryPoint(sign.points[0][0], sign.points[0][1], initial);
    for (let i = 1; i < sign.points.length && i < 700; i++) {
      const a = sign.points[i - 1], b = sign.points[i];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const dir = { x: (b[0] - a[0]) / (length || 1), z: (b[1] - a[1]) / (length || 1) };
      tryPoint(a[0] + (b[0] - a[0]) * .5, a[1] + (b[1] - a[1]) * .5, dir);
    }
    if (!best || best.near.dist2 > 20 * 20) continue;
    const direct = String(sign.tags.traffic_sign || '');
    const fwd = String(sign.tags['traffic_sign:forward'] || '');
    const bwd = String(sign.tags['traffic_sign:backward'] || '');
    const hasCityLimit = /city_limit/i.test(direct) || /city_limit/i.test(fwd) || /city_limit/i.test(bwd);
    const hasEB10 = /FR:EB10/i.test(direct) || /FR:EB10/i.test(fwd) || /FR:EB10/i.test(bwd);
    if (!hasCityLimit && !hasEB10) continue;
    let name = '';
    for (const k of ['name', 'name:forward', 'name:backward', 'alt_name']) {
      if (sign.tags[k]) { name = String(sign.tags[k]).trim(); break; }
    }
    if (!name) {
      const loc = osmNearestLocality(best.x, best.z, localities, 2000);
      if (loc) name = loc.name;
    }
    if (!name) continue;
    osmPushCityEntry({
      distance: best.near.distance,
      name,
      source: 'osm',
      x: best.x, z: best.z, y: best.near.y,
      tx: best.near.tx, tz: best.near.tz
    });
  }
  for (const poly of polygons) {
    const strict = poly.place && /^(city|town|village)$/.test(poly.place);
    const crossings = [];
    for (let i = 0; i < route.n; i++) {
      const a = [route.X[i], route.Z[i]];
      const b = [route.X[i + 1], route.Z[i + 1]];
      for (let j = 1; j < poly.points.length; j++) {
        const c = poly.points[j - 1], d = poly.points[j];
        const rx = b[0] - a[0], rz = b[1] - a[1];
        const sx = d[0] - c[0], sz = d[1] - c[1];
        const den = rx * sz - rz * sx;
        if (Math.abs(den) < 1e-9) continue;
        const qx = c[0] - a[0], qz = c[1] - a[1];
        const t = (qx * sz - qz * sx) / den;
        const u = (qx * rz - qz * rx) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        const distance = (i + t) * (route.step || ST);
        if (crossings.some(h => Math.abs(h.distance - distance) < 4)) continue;
        const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
        const before = at(Math.max(0, distance - 2));
        const after = at(Math.min(route.len - .01, distance + 2));
        const bIn = osmPointInPolygon(poly.points, before[0], before[2]);
        const aIn = osmPointInPolygon(poly.points, after[0], after[2]);
        const type = !bIn && aIn ? 'entry' : bIn && !aIn ? 'exit' : null;
        if (!type) continue;
        const near = nearestOnRoute(x, z);
        if (near) crossings.push({ x, z, near, distance: near.distance, type });
      }
    }
    for (const cross of crossings) {
      const ownName = strict && String(poly.tags.name || '').trim();
      const locality = ownName
        ? { name: ownName, place: poly.place }
        : osmNearestLocality(cross.x, cross.z, localities, 2000);
      if (!locality) continue;
      if (strict && !/^(city|town|village)$/.test(locality.place)) continue;
      if (!/^(city|town|village)$/.test(locality.place || '')) continue;
      if (cross.type === 'exit') {
        osmPushBoundaryEvent({
          distance: cross.distance,
          name: locality.name,
          source: 'osm-boundary',
          type: 'exit',
          x: cross.x, z: cross.z, y: cross.near.y
        });
        continue;
      }
      osmPushCityEntry({
        distance: cross.distance,
        name: locality.name,
        source: 'estimated',
        x: cross.x, z: cross.z, y: cross.near.y,
        tx: cross.near.tx, tz: cross.near.tz
      });
    }
  }
  for (const entry of cityEntries) createTownSign(entry, targetWorld);
  return cityEntries;
}

// ============================================================
// FONCTION PRINCIPALE : APPLY OSM
// ============================================================
function applyOSM(elements, targetWorld) {
  const target = targetWorld || world;
  if (!target || !route) return { b: 0, w: 0, t: 0, h: 0, hm: 0, he: 0, r: 0, c: 0, roundabouts: 0 };
  resetSceneryData();
  const buildingsList = [], waters = [], forests = [], roads = [];
  const hedgeList = [], treeRows = [], treeNodes = [];
  const residentialAreas = [], localities = [];

  for (const element of elements || []) {
    const tags = element.tags || {};
    const points = osmElementPoints(element);
    if (element.type === 'node' && points.length &&
        /^(city|town|village|hamlet|suburb)$/.test(String(tags.place || '')) &&
        String(tags.name || '').trim()) {
      localities.push({
        name: String(tags.name).trim(),
        place: tags.place,
        x: points[0][0], z: points[0][1]
      });
    }
    if (element.type === 'node' && tags.natural === 'tree' && points.length) {
      treeNodes.push(points[0]);
      continue;
    }
    if (points.length < 2) continue;

    if (tags.highway) {
      const hw = String(tags.highway).toLowerCase();
      const isPath = /^(path|footway|steps|bridleway|pedestrian|corridor|elevator|escalator)$/.test(hw);
      const isUnpavedTrack = hw === 'track' && /^(ground|dirt|grass|sand|earth|mud|gravel|unpaved)$/i.test(String(tags.surface || ''));
      const isDeadEnd = String(tags.dead_end || '').toLowerCase() === 'yes';
      const isCulDeSac = String(tags.noexit || '') === 'yes';
      if (!isPath && !isUnpavedTrack && !isDeadEnd && !isCulDeSac) {
        roads.push([points, tags]);
        osmMapFeatures.push({ type: 'road', points: osmCopyPoints(points), tags });
      }
      continue;
    }

    if (tags.building) {
      buildingsList.push([points, tags]);
      osmMapFeatures.push({ type: 'building', points: osmCopyPoints(points) });
    } else if (tags.natural === 'water') {
      waters.push(points);
      osmMapFeatures.push({ type: 'water', points: osmCopyPoints(points) });
    } else if (tags.natural === 'wood' || tags.landuse === 'forest') {
      forests.push(points);
      osmMapFeatures.push({ type: 'forest', points: osmCopyPoints(points) });
    } else if (tags.barrier === 'hedge' || tags.landuse === 'hedge' || tags.natural === 'hedge') {
      hedgeList.push([points, tags]);
      osmMapFeatures.push({ type: 'hedge', points: osmCopyPoints(points) });
    } else if (tags.landuse === 'residential' && osmClosed(points)) {
      residentialAreas.push(points);
    } else if (tags.natural === 'tree_row') {
      treeRows.push(points);
    }
  }
  osmPublishSceneryData();
  const heightAt = (x, z) => {
    const near = nearestOnRoute(x, z);
    return near ? near.y : 0;
  };
  const asShape = points => new THREE.Shape(points.map(p => new THREE.Vector2(p[0], -p[1])));
  const flatten = g => { g.rotateX(-Math.PI / 2); return g.index ? g.toNonIndexed() : g; };
  const addMerged = (parts, colour) => {
    if (!parts.length) return;
    let length = 0;
    parts.forEach(p => { length += p.length; });
    const data = new Float32Array(length);
    let offset = 0;
    parts.forEach(p => { data.set(p, offset); offset += p.length; });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data, 3));
    geometry.computeVertexNormals();
    target.add(new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: colour, side: THREE.DoubleSide })));
  };

  const buildingCount = buildings(buildingsList, target);
  const waterParts = [];
  for (const points of waters.slice(0, 150)) {
    if (!osmClosed(points)) continue;
    try {
      const geometry = flatten(new THREE.ShapeGeometry(asShape(points)));
      geometry.translate(0, heightAt(points[0][0], points[0][1]) - .15, 0);
      waterParts.push(geometry.attributes.position.array.slice());
      geometry.dispose();
    } catch (_) {}
  }
  addMerged(waterParts, 0x3b87c7);

  const trees = treeNodes.slice(0, 1800);
  for (const points of forests) {
    if (!osmClosed(points)) continue;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
    }
    const tries = Math.min(250, Math.floor((maxX - minX) * (maxZ - minZ) / 500));
    for (let i = 0; i < tries && trees.length < 1800; i++) {
      const x = minX + Math.random() * (maxX - minX);
      const z = minZ + Math.random() * (maxZ - minZ);
      if (osmPointInPolygon(points, x, z)) trees.push([x, z]);
    }
  }
  for (const points of treeRows) {
    for (let i = 1; i < points.length && trees.length < 1800; i++) {
      const a = points[i - 1], b = points[i];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let d = 0; d < length && trees.length < 1800; d += 8)
        trees.push([a[0] + (b[0] - a[0]) * d / length, a[1] + (b[1] - a[1]) * d / length]);
    }
  }

  collectRoundaboutZones(roads);
  sideRoadLines = roads.map(([pts]) => pts);

  const estimatedHedges = estimateRuralHedges(buildingsList, hedgeList, residentialAreas, localities);
  for (const [points] of estimatedHedges)
    osmMapFeatures.push({ type: 'hedge-estimated', points: osmCopyPoints(points) });
  const hedgeCounts = hedges([...hedgeList, ...estimatedHedges], target);
  const hedgeCount = hedgeCounts.mapped + hedgeCounts.estimated;

  if (trees.length) {
    const trunkGeo = new THREE.CylinderGeometry(.18, .28, 3.2, 7);
    trunkGeo.translate(0, 1.6, 0);
    const trunkMesh = new THREE.InstancedMesh(
      trunkGeo,
      new THREE.MeshStandardMaterial({ color: 0x5a3d26, roughness: .9 }),
      trees.length
    );
    const matrix = new THREE.Matrix4();
    const leafGeo = new THREE.SphereGeometry(1.9, 10, 8);
    const leafMesh = new THREE.InstancedMesh(
      leafGeo,
      new THREE.MeshStandardMaterial({ color: 0x2e7a34, roughness: .85 }),
      trees.length * 4
    );
    const m2 = new THREE.Matrix4();
    trees.forEach((point, i) => {
      const s = .8 + Math.random() * 1.1;
      const y = heightAt(point[0], point[1]) - .4;
      matrix.makeScale(s, s, s);
      matrix.setPosition(point[0], y, point[1]);
      trunkMesh.setMatrixAt(i, matrix);
      for (let k = 0; k < 4; k++) {
        const a = Math.random() * Math.PI * 2;
        const r = k === 0 ? 0 : 1.1 + Math.random() * .8;
        const ls = 1.05 + Math.random() * .65;
        m2.makeScale(s * ls, s * ls * .85, s * ls);
        m2.setPosition(
          point[0] + Math.cos(a) * r * s,
          y + 3.4 + (k === 0 ? 1.0 : Math.random() * .8) * s,
          point[1] + Math.sin(a) * r * s
        );
        leafMesh.setMatrixAt(i * 4 + k, m2);
      }
    });
    trunkMesh.instanceMatrix.needsUpdate = true;
    leafMesh.instanceMatrix.needsUpdate = true;
    target.add(trunkMesh);
    target.add(leafMesh);
    if (target.userData.rt) target.userData.rt.visible = false;
  }

  const roadStats = buildRoadNetwork(selectRoadsForScene(roads, 1200), target);
  const furnCount = buildRoadFurniture(elements, target);
  makeTownEntries(elements, target);
  return {
    b: buildingCount,
    w: Math.min(waters.length, 150),
    t: trees.length,
    h: hedgeCount,
    hm: hedgeCounts.mapped,
    he: hedgeCounts.estimated,
    r: roadStats.drawn,
    roundabouts: roadStats.roundabouts,
    c: cityEntries.length
  };
}

function buildRoadFurniture(elements, target) {
  const items = [];
  for (const el of elements || []) {
    const tags = el.tags || {};
    const pts = osmElementPoints(el);
    if (!pts.length) continue;
    let kind = null;
    if (tags.highway === 'traffic_signals' || /traffic_signals/.test(String(tags.traffic_sign || ''))) kind = 'signals';
    else if (tags.highway === 'stop' || /\bstop\b/.test(String(tags.traffic_sign || ''))) kind = 'stop';
    else if (tags.highway === 'give_way' || /give_way|yield/.test(String(tags.traffic_sign || ''))) kind = 'yield';
    if (!kind) continue;
    const near = nearestOnRoute(pts[0][0], pts[0][1]);
    if (!near || near.dist2 > 30 * 30) continue;
    items.push({ kind, x: pts[0][0], z: pts[0][1], y: near.y });
  }
  for (const z of roundaboutZones) {
    for (let k = 0; k < 3; k++) {
      const a = k / 3 * Math.PI * 2;
      const x = z.x + Math.cos(a) * (z.r + 1.5);
      const zz = z.z + Math.sin(a) * (z.r + 1.5);
      const n = nearestOnRoute(x, zz);
      items.push({ kind: 'yield', x, z: zz, y: n ? n.y : 0 });
      items.push({
        kind: 'yieldMark',
        x: z.x + Math.cos(a) * (z.r - .5),
        z: z.z + Math.sin(a) * (z.r - .5)
      });
    }
  }
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const red = new THREE.MeshStandardMaterial({ color: 0xc81e1e, roughness: .5 });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: .6 });
  for (const it of items) {
    const group = new THREE.Group();
    group.position.set(it.x, it.y, it.z);
    if (it.kind === 'yieldMark') {
      const tri = new THREE.Mesh(new THREE.CircleGeometry(.55, 3), white);
      tri.rotation.x = -Math.PI / 2;
      tri.rotation.z = Math.PI;
      tri.position.y = .06;
      group.add(tri);
    } else {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(.03, .03, 2.2, 8), poleMat);
      pole.position.y = 1.1;
      group.add(pole);
      if (it.kind === 'stop') {
        const oct = new THREE.Mesh(new THREE.CylinderGeometry(.32, .32, .06, 8), red);
        oct.rotation.x = Math.PI / 2;
        oct.position.y = 2.4;
        group.add(oct);
        const disc = new THREE.Mesh(new THREE.CircleGeometry(.22, 16), white);
        disc.position.set(0, 2.4, .04);
        group.add(disc);
      } else if (it.kind === 'yield') {
        const tri = new THREE.Mesh(
          new THREE.CircleGeometry(.32, 3),
          new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .5 })
        );
        tri.position.y = 2.4;
        group.add(tri);
        const inner = new THREE.Mesh(new THREE.CircleGeometry(.20, 3), red);
        inner.position.set(0, 2.4, .02);
        group.add(inner);
      } else if (it.kind === 'signals') {
        const box = new THREE.Mesh(new THREE.BoxGeometry(.25, .75, .18), poleMat);
        box.position.y = 2.6;
        group.add(box);
        const colors = [0x22c55e, 0xf59e0b, 0xef4444];
        for (let i = 0; i < 3; i++) {
          const lamp = new THREE.Mesh(
            new THREE.CircleGeometry(.09, 12),
            new THREE.MeshBasicMaterial({ color: colors[i] })
          );
          lamp.position.set(0, 2.85 - i * .22, .10);
          group.add(lamp);
        }
      }
    }
    target.add(group);
  }
  return items.length;
}
// FIN DU MORCEAU 3
    // ============================================================
// CHARGEMENT OSM
// ============================================================
async function loadOSM() {
  const token = ++osmTok, targetWorld = world;
  const isCurrent = () => osmCurrent(token, targetWorld);
  if (!targetWorld || !route || !proj) { osmSetSkipVisible(false); return; }
  const freeCache = window._freeNavigation;
  osmLoadingToken = token;
  osmSetSkipVisible(!(freeCache && freeCache.active && Array.isArray(freeCache.elements)));
  try {
    if (freeCache && freeCache.active && Array.isArray(freeCache.elements)) {
      const ready = Array.isArray(freeCache.preparedElements)
        ? freeCache.preparedElements
        : freePrepareScenery(freeCache.path, freeCache);
      freeCache.preparedElements = null;
      if (osmStopIfStale(token, targetWorld)) return;
      osmProgress(.86, 'Assemblage du décor préchargé…');
      const result = ready.length ? applyOSM(ready, targetWorld) : { b: 0, w: 0, t: 0, h: 0, hm: 0, he: 0, r: 0, roundabouts: 0, c: 0 };
      if (osmStopIfStale(token, targetWorld)) return;
      osmProgress(.96, 'Décor local finalisé.');
      osmSetStartEnabled(true);
      osmProgress(1, 'Parcours prêt.');
      osmFinishLoading(token);
      return;
    }
    const total = Math.min(route.len, OSM_ROUTE_CAP_METRES);
    const chunks = Math.max(1, Math.ceil(total / OSM_CHUNK_METRES));
    const seen = new Set(), elements = [];
    let failures = 0;

    osmToast('Test des serveurs OSM…');
    const probe = await osmProbeServers();
    if (osmStopIfStale(token, targetWorld)) return;
    if (!probe.live.length) {
      osmProgress(0, 'Aucun serveur OSM joignable. Lance sans décor.');
      osmSetStartEnabled(true);
      osmFinishLoading(token);
      return;
    }
    for (let chunk = 0; chunk < chunks; chunk++) {
      if (osmStopIfStale(token, targetWorld)) return;
      const d0 = chunk * OSM_CHUNK_METRES;
      const d1 = Math.min(total, d0 + OSM_CHUNK_METRES);
      const line = [];
      for (let d = d0; d <= d1 + 99; d += 100) {
        const p = at(Math.min(d, d1));
        line.push((proj.la - p[2] / proj.kz).toFixed(5), (proj.lo + p[0] / proj.kx).toFixed(5));
      }
      const corridor = line.join(',');
      const query = `[out:json][timeout:25];(
        way["building"](around:120,${corridor});
        way["natural"~"^(water|wood)$"](around:150,${corridor});
        way["highway"](around:90,${corridor});
        way["barrier"="hedge"](around:90,${corridor});
        node["place"~"^(city|town|village)$"]["name"](around:2000,${corridor});
      );out body geom 6000;`;
      let json;
      try {
        json = await osmAsk(query, probe.live);
      } catch (error) {
        if (osmStopIfStale(token, targetWorld)) return;
        failures++;
        if (failures >= 3) break;
        continue;
      }
      if (osmStopIfStale(token, targetWorld)) return;
      failures = 0;
      if (Array.isArray(json && json.elements)) {
        for (const element of json.elements) {
          const key = osmElementKey(element);
          if (!seen.has(key)) { seen.add(key); elements.push(element); }
        }
      }
      osmProgress((chunk + 1) / chunks, 'Décor OSM : tranche ' + (chunk + 1) + '/' + chunks);
    }
    if (!elements.length) {
      osmProgress(1, 'Aucun décor OSM reçu. Lance sans décor.');
      osmSetStartEnabled(true);
      osmFinishLoading(token);
      return;
    }
    osmProgress(1, 'Construction du décor…');
    await osmSleep(30);
    if (osmStopIfStale(token, targetWorld)) return;
    const result = applyOSM(elements, targetWorld);
    if (osmStopIfStale(token, targetWorld)) return;
    osmProgress(1, 'Décor prêt !');
    osmSetStartEnabled(true);
    osmFinishLoading(token);
  } catch (error) {
    if (osmStopIfStale(token, targetWorld)) return;
    osmToast('Erreur décor : ' + error.message);
    osmSetStartEnabled(true);
    osmFinishLoading(token);
  }
}

// ============================================================
// ROULER LIBRE
// ============================================================
const freeRouteableHighways = new Set(['primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','unclassified','residential','living_street','service','road','cycleway']);
const freeExcludedHighways = new Set(['motorway','motorway_link','trunk','trunk_link','footway','path','pedestrian','steps','bridleway','raceway','construction','proposed']);

function freeNodeKey(point) {
  return point && point.nodeId != null ? 'n:' + point.nodeId : point ? 'p:' + Number(point.lat).toFixed(6) + ',' + Number(point.lon).toFixed(6) : '';
}
function freeValidCoord(point) {
  return point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon)) && Math.abs(Number(point.lat)) <= 90 && Math.abs(Number(point.lon)) <= 180;
}
function freeMapRadius() {
  const radius = Math.max(750, Number($('freeRadius') && $('freeRadius').value) || 2000);
  if (window._freeCircle) {
    window._freeCircle.setRadius(radius);
    if (freeCenter) window._freeCircle.setLatLng([freeCenter.lat, freeCenter.lon]);
  }
  return radius;
}
function initFreeMap() {
  const el = $('freeMap');
  if (!el || freeMap || !window.L) return;
  freeMap = L.map(el).setView([freeCenter.lat, freeCenter.lon], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OSM' }).addTo(freeMap);
  freeMarker = L.marker([freeCenter.lat, freeCenter.lon]).addTo(freeMap);
  window._freeCircle = L.circle([freeCenter.lat, freeCenter.lon], { radius: freeMapRadius(), color: '#34d399', fillOpacity: .12, weight: 2 }).addTo(freeMap);
  freeMap.on('click', e => {
    const ll = e && e.latlng;
    if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) return;
    freeCenter = { lat: ll.lat, lon: ll.lng };
    freeMarker.setLatLng(ll);
    window._freeCircle.setLatLng(ll);
    freeClearStartChoices();
    $('freeInfo').textContent = 'Départ choisi · touche « Rouler ici »';
  });
}
function freeClearStartChoices() {
  freeNavigation = null;
  freeGraph = null;
  freeJunctions = null;
  window._freeNavigation = null;
  window._freeSectorCache = null;
  window._freeGraph = null;
  window._freeCurrentWay = null;
  if ($('turnAround')) $('turnAround').disabled = true;
  if ($('freeStartDialog')) $('freeStartDialog').classList.add('hide');
  hideDirectionPanel();
}
function freeProject(point, center) {
  const kx = 111320 * Math.cos(center.lat * Math.PI / 180), kz = 110540;
  return { x: (point.lon - center.lon) * kx, z: -(point.lat - center.lat) * kz };
}
function freeMakeGraph(elements, center) {
  const graph = [];
  for (const element of elements) {
    if (!element || element.type !== 'way' || !element.tags || !element.tags.highway || !Array.isArray(element.geometry)) continue;
    const highway = String(element.tags.highway).toLowerCase();
    if (!freeRouteableHighways.has(highway) || freeExcludedHighways.has(highway)) continue;
    if (String(element.tags.dead_end || '').toLowerCase() === 'yes' || String(element.tags.noexit || '').toLowerCase() === 'yes') continue;
    const pts = element.geometry.map((p, i) => freeValidCoord(p) ? { lat: Number(p.lat), lon: Number(p.lon), ele: Number.isFinite(Number(p.ele)) ? Number(p.ele) : null, nodeId: Array.isArray(element.nodes) ? element.nodes[i] : null } : null).filter(Boolean);
    if (pts.length < 2) continue;
    graph.push({ id: element.id, name: element.tags.name || 'Route', highway, tags: element.tags, nodes: element.nodes || [], pts });
  }
  const map = new Map();
  for (const way of graph) for (let i = 0; i < way.pts.length; i++) {
    const key = freeNodeKey(way.pts[i]);
    if (!map.has(key)) map.set(key, { key, point: way.pts[i], incidents: [] });
    const node = map.get(key);
    if (!node.incidents.some(a => a.way === way && a.index === i)) node.incidents.push({ way, index: i });
  }
  const junctions = new Map([...map].filter(([, node]) => new Set(node.incidents.map(a => a.way)).size > 1));
  const localities = [];
  return { graph, junctions, localities };
}
function freeRaw(points, nav) {
  return points.map(p => {
    const q = freeProject(p, nav.center);
    return { x: q.x, z: q.z, y: Number.isFinite(p.ele) ? p.ele : 0 };
  });
}
function showDirectionPanel(distance, options) {
  const panel = $('directionPanel');
  if (!panel) return;
  const distEl = $('junctionDistance');
  const barEl = $('junctionBarFill');
  const choicesEl = $('directionChoices');
  if (!distEl || !choicesEl) return;
  distEl.innerHTML = Math.ceil(Math.max(0, distance) / 10) * 10 + '<small>m</small>';
  if (barEl) barEl.style.width = (Math.max(0, Math.min(1, 1 - distance / 350)) * 100) + '%';
  choicesEl.replaceChildren();
  for (const option of options) {
    const btn = document.createElement('button');
    btn.className = 'dirChoice';
    btn.innerHTML = `<span class="arrowGlyph">${option.arrow || '↑'}</span><span class="dirCity">${option.city || ''}</span><span class="dirDistance">${option.cityDistanceKm ? '≈ '+option.cityDistanceKm.toFixed(1)+' km' : ''}</span>`;
    btn.onclick = () => {
      for (const b of choicesEl.querySelectorAll('button')) b.classList.remove('selected');
      btn.classList.add('selected');
      option._selected = true;
      if (option._onSelect) option._onSelect();
    };
    choicesEl.appendChild(btn);
  }
  panel.classList.add('show');
}
function hideDirectionPanel() { if ($('directionPanel')) $('directionPanel').classList.remove('show'); }
function updateDirectionPanel(distance) {
  const distEl = $('junctionDistance');
  if (distEl) distEl.innerHTML = Math.ceil(Math.max(0, distance) / 10) * 10 + '<small>m</small>';
}

// ============================================================
// BLUETOOTH
// ============================================================
function onBike(e) {
  const d = e.target.value;
  if (d.byteLength < 2) return;
  try {
    const flags = d.getUint16(0, true);
    let o = 2;
    if (!(flags & 1)) o += 2;
    if (flags & 2) o += 2;
    if (flags & 4) { cad = d.getUint16(o, true) === 65535 ? 0 : d.getUint16(o, true) / 2; o += 2; }
    if (flags & 8) o += 2;
    if (flags & 16) o += 3;
    if (flags & 32) o += 2;
    if (flags & 64) lastP = Math.max(0, d.getInt16(o, true));
  } catch (err) {}
}
let lastGradeSent = 0;
async function sendGrade(g) {
  if (!ctl || busy) return;
  busy = true;
  const b = new DataView(new ArrayBuffer(7));
  b.setUint8(0, 0x11); b.setInt16(1, 0, true); b.setInt16(3, Math.round(g * 10000), true);
  try { await ctl.writeValueWithResponse(b); } catch (e) {}
  busy = false; lastGradeSent = g;
}
$('bt').onclick = async () => {
  if (!navigator.bluetooth) return toast('Bluetooth indisponible (Chrome Android requis).');
  try {
    const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [0x1826] }] });
    dev.addEventListener('gattserverdisconnected', () => { ctl = null; lastP = 0; $('bt').classList.remove('on'); $('sl').classList.remove('hide'); });
    const sv = await (await dev.gatt.connect()).getPrimaryService(0x1826);
    const ib = await sv.getCharacteristic(0x2AD2);
    ib.addEventListener('characteristicvaluechanged', onBike);
    await ib.startNotifications();
    const cp = await sv.getCharacteristic(0x2AD9);
    try { await cp.startNotifications(); } catch (e) {}
    await cp.writeValueWithResponse(Uint8Array.of(0x00));
    await cp.writeValueWithResponse(Uint8Array.of(0x07));
    ctl = cp; $('bt').classList.add('on'); $('sl').classList.add('hide');
  } catch (e) { toast('Trainer : ' + e.message); }
};
$('hb').onclick = async () => {
  if (!navigator.bluetooth) return toast('Bluetooth indisponible.');
  try {
    const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [0x180D] }] });
    const sv = await (await dev.gatt.connect()).getPrimaryService(0x180D);
    const c = await sv.getCharacteristic(0x2A37);
    c.addEventListener('characteristicvaluechanged', e => { const d = e.target.value; hr = (d.getUint8(0) & 1) ? d.getUint16(1, true) : d.getUint8(1); });
    await c.startNotifications(); $('hb').classList.add('on');
  } catch (e) { toast('Cardio : ' + e.message); }
};
setInterval(() => { if (route && ctl && running) { const g = at(s)[3]; if (Math.abs(g - lastGradeSent) > .005) sendGrade(g); } }, 1000);

// ============================================================
// FIT & UI
// ============================================================
function crc16(data) { let crc = 0; for (const b of data) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : crc >> 1; } return crc; }
function unixToFit(unixSec) { return Math.round(unixSec - FIT_EPOCH); }
function fitBytes() {
  const samples = sessionSamples.length ? sessionSamples : [{ t: 0, dist: 0 }];
  const body = [];
  const B = v => body.push(v & 255);
  const B16 = v => { B(v); B(v >> 8); };
  const B32 = v => { for (let i = 0; i < 4; i++) B(v >> (i * 8)); };
  const def = (l, g, f) => { B(0x40 | l); B(0); B(g); B(g >> 8); B(f.length); for (const [n, s, t] of f) { B(n); B(s); B(t); } };
  const data = (l, ...v) => { B(l); for (const [val, sz] of v) { if (sz === 1) B(val); else if (sz === 2) B16(val); else B32(val); } };
  def(0, 0, [[0, 1, 0], [1, 2, 132], [2, 4, 140], [3, 4, 140], [4, 2, 132]]);
  data(0, [4, 1], [1, 2], [0, 4], [0, 4], [1, 2]);
  def(3, 34, [[253, 4, 134], [0, 2, 132], [1, 2, 132], [2, 2, 132]]);
  const startFit = unixToFit((sessionStart || Date.now()) / 1000);
  data(3, [startFit, 4], [0, 2], [0, 2], [0, 2]);
  const dur = Math.round(samples[samples.length - 1].t || 0);
  const totalDist = Math.round(totalDistance * 100);
  def(1, 18, [[253, 4, 134], [7, 4, 134], [9, 4, 134]]);
  data(1, [startFit, 4], [dur * 1000, 4], [totalDist, 4]);
  def(2, 20, [[253, 4, 134], [0, 4, 133], [1, 4, 133], [5, 4, 134], [3, 1, 2], [4, 1, 2]]);
  for (const s of samples) {
    const ts = unixToFit((sessionStart || Date.now()) / 1000 + (s.t || 0));
    data(2, [ts, 4], [s.lat ? Math.round(s.lat * 2147483648 / 180) : 0x7fffffff, 4], [s.lon ? Math.round(s.lon * 2147483648 / 180) : 0x7fffffff, 4], [Math.round(s.dist * 100), 4], [Math.round(s.power) || 0, 1], [Math.round(s.cad) || 0, 1]);
  }
  const header = [14, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  header[4] = body.length & 255; header[5] = (body.length >> 8) & 255; header[6] = (body.length >> 16) & 255; header[7] = (body.length >> 24) & 255;
  const hcrc = crc16(header.slice(0, 12)); header[12] = hcrc & 255; header[13] = (hcrc >> 8) & 255;
  const bodyCrc = crc16(body);
  return new Uint8Array([...header, ...body, bodyCrc & 255, (bodyCrc >> 8) & 255]);
}
$('exportFit').onclick = () => {
  const blob = new Blob([fitBytes()], { type: 'application/vnd.ant.fit' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'seance.fit'; a.click();
};
$('openStrava').onclick = () => window.open('https://www.strava.com/upload/select', '_blank');
$('skipScenery').onclick = () => { ++osmTok; $('skipScenery').classList.add('hide'); $('go').disabled = false; prog(1, 'Parcours prêt.'); };
$('pw').oninput = e => { $('pv').textContent = e.target.value; };
$('mapMode').onclick = () => { mapState.overview = !mapState.overview; $('mapMode').textContent = mapState.overview ? 'Suivi' : 'Tout'; mapState.last = 0; };
$('mapClose').onclick = () => { mapState.visible = false; $('mapPanel').classList.add('hide'); $('mapToggle').classList.remove('hide'); };
$('mapToggle').onclick = () => { mapState.visible = true; $('mapPanel').classList.remove('hide'); $('mapToggle').classList.add('hide'); mapState.last = 0; };

// ============================================================
// GPX
// ============================================================
function parseGPX(txt) {
  txt = String(txt).replace(/^\uFEFF/, '').trim();
  const P = [];
  for (const tag of ['trkpt', 'rtept', 'wpt']) {
    for (const ch of txt.split(new RegExp('<(?:\\w+:)?' + tag + '\\b')).slice(1)) {
      const head = ch.slice(0, ch.indexOf('>') + 1);
      const la = /\blat\s*=\s*["']([-+0-9.eE]+)["']/.exec(head), lo = /\blon\s*=\s*["']([-+0-9.eE]+)["']/.exec(head);
      const e = ch.match(/<(?:\w+:)?ele>\s*([-+0-9.eE]+)/);
      if (la && lo && isFinite(+la[1]) && isFinite(+lo[1])) P.push({ lat: +la[1], lon: +lo[1], ele: e ? +e[1] : 0 });
    }
    if (P.length >= 2) break;
    P.length = 0;
  }
  if (P.length < 2) throw new Error('Aucun point trouvé.');
  proj = { la: P[0].lat, lo: P[0].lon, kx: 111320 * Math.cos(P[0].lat * Math.PI / 180), kz: 110540 };
  return P.map(p => ({ x: (p.lon - proj.lo) * proj.kx, z: -(p.lat - proj.la) * proj.kz, y: p.ele }));
}
$('gp').onclick = () => $('fi').click();
$('fi').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  if (window._clearFreeNavigation) window._clearFreeNavigation();
  try { build(parseGPX(await f.text())); } catch (err) { toast('Erreur : ' + err.message); }
};
$('pg').onclick = () => { $('pe').textContent = ''; $('pp').classList.remove('hide'); };
$('px').onclick = () => $('pp').classList.add('hide');
$('pl').onclick = () => { try { if (window._clearFreeNavigation) window._clearFreeNavigation(); build(parseGPX($('pt').value)); $('pp').classList.add('hide'); } catch (err) { $('pe').textContent = err.message; } };
$('dm').onclick = () => demo();
// FIN DU MORCEAU 4
    // ============================================================
// WAKE LOCK & UI PROFIL
// ============================================================
let _wakeLock = null, _wakeLockWanted = false;
async function requestWakeLock() {
  _wakeLockWanted = true;
  if (!('wakeLock' in navigator) || document.hidden || _wakeLock) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => {
      _wakeLock = null;
      if (_wakeLockWanted && !document.hidden) setTimeout(requestWakeLock, 250);
    });
  } catch (e) {}
}
async function releaseWakeLock() {
  _wakeLockWanted = false;
  const lock = _wakeLock;
  _wakeLock = null;
  if (lock) try { await lock.release(); } catch (e) {}
}
function renderZonesPreview() {
  const z = zonesFromFTP(profile.ftp);
  $('zonesPreview').innerHTML = z.map(zone => `<div class="zoneRow"><span class="zoneName zone${zone.name}">${zone.name}</span><span>${zone.min} – ${zone.max} W</span></div>`).join('');
}
function applyProfileToInputs() {
  if ($('userWeight')) $('userWeight').value = profile.weight;
  if ($('userFTP')) $('userFTP').value = profile.ftp;
  if ($('userHRMax')) $('userHRMax').value = profile.hrMax;
  renderZonesPreview();
}
applyProfileToInputs();
$('saveSettings').onclick = () => {
  const w = Number($('userWeight').value), f = Number($('userFTP').value), h = Number($('userHRMax').value);
  if (w >= 30 && w <= 150 && f >= 80 && f <= 500 && h >= 120 && h <= 220) {
    profile = { weight: w, ftp: f, hrMax: h, units: 'metric' };
    saveProfile();
    renderZonesPreview();
    toast('Paramètres enregistrés ✅');
  } else { toast('Valeurs invalides.'); }
};
for (const tab of document.querySelectorAll('.homeTab')) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll('.homeTab')) t.classList.remove('active');
    for (const p of document.querySelectorAll('.homePanel')) p.classList.remove('active');
    tab.classList.add('active');
    const panel = document.querySelector('.homePanel[data-panel="' + tab.dataset.tab + '"]');
    if (panel) panel.classList.add('active');
    if (tab.dataset.tab === 'style') setTimeout(drawPreview, 30);
  };
}

// ============================================================
// BOUCLE PRINCIPALE — PHYSIQUE TOPOGRAPHIQUE
// ============================================================
let last = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.max(0, Math.min((t - last) / 1000, .1));
  last = t;
  if (!route) { R.render(S, cam); return; }

  const power = ctl ? lastP : +$('pw').value;
  const grade = at(s)[3];
  const slope = Math.atan(grade);
  const MASS = profile.weight + 10;
  const force = MASS * G0 * (CRR * Math.cos(slope) + Math.sin(slope)) + .5 * RHO * CD * v * v;

  // Démarrage automatique à la 1ère watt
  const hasPower = power > 5;
  if (!running && hasPower && s < route.len) {
    running = true;
    sessionStart = sessionStart || Date.now();
    $('pause').textContent = 'Pause';
    requestWakeLock();
  }

  if (running) {
    const pedalForce = hasPower ? power * .975 / Math.max(v, .5) : 0;
    const driveForce = Math.min(pedalForce, force + MASS * 2.2);
    let accel = (driveForce - force) / MASS;
    if (v <= 0 && accel < 0) accel = 0;
    v = Math.max(0, v + accel * dt);
    v = Math.min(v, 45 / 3.6);
    const advance = Math.min(v * dt, route.len - s);
    s += advance;
    totalDistance += advance;
    if (s >= route.len) {
      s = route.len;
      const freeNav = window._freeNavigation;
      if (!(freeNav && freeNav.active)) {
        running = false; v = 0; $('pause').textContent = 'Repartir';
        toast('Parcours terminé · ' + (totalDistance / 1000).toFixed(2) + ' km.');
        if (ctl) sendGrade(0);
      }
    }
  } else {
    v = Math.max(0, v - .5 * dt);
  }

  if (running && hasPower) kcal += power * dt / 1000 * 3.6;
  if (window._freeNavigation && window._freeNavigation.active) freeAdvanceNavigation();

  if (running && t - lastSampleT > 1000) {
    lastSampleT = t;
    if (!sessionStart) sessionStart = Date.now();
    const gps = proj ? at(s) : null;
    sessionSamples.push({ t: rideElapsed, dist: totalDistance, power: ctl ? lastP : +$('pw').value, hr, cad, lat: gps ? proj.la - gps[2] / proj.kz : null, lon: gps ? proj.lo + gps[0] / proj.kx : null });
  }
  if (running) rideElapsed += dt;

  place(false, dt);
  if (running) animRider(dt);
  drawMiniMap(t);
  updateTownUI();

  // Mise à jour interface
  if ($('sp')) $('sp').textContent = Math.round(v * 3.6);
  if ($('po')) $('po').textContent = Math.round(power);
  if ($('gr')) $('gr').textContent = (grade * 100).toFixed(1);
  if ($('di')) $('di').textContent = (totalDistance / 1000).toFixed(2);
  if ($('du')) $('du').textContent = String(Math.floor(rideElapsed / 60)).padStart(2, '0') + ':' + String(Math.floor(rideElapsed) % 60).padStart(2, '0');
  if ($('avgSpeed')) $('avgSpeed').textContent = (rideElapsed > 0 ? totalDistance / rideElapsed * 3.6 : 0).toFixed(1);
  if ($('hr')) $('hr').textContent = hr || '–';
  if ($('ca')) $('ca').textContent = ctl && cad ? Math.round(cad) : '–';
  if ($('kcal')) $('kcal').textContent = Math.round(kcal);

  if ($('po')) {
    const zone = zoneOf(power);
    $('po').parentElement.className = 'm zone' + zone.name.slice(1);
  }
  R.render(S, cam);
}

// ============================================================
// INITIALISATION & BOUTONS
// ============================================================
$('go').onclick = () => {
  $('home').classList.add('hide');
  running = true; $('pause').textContent = 'Pause';
  last = performance.now(); requestWakeLock();
};
$('mn').onclick = () => { running = false; hideDirectionPanel(); $('home').classList.remove('hide'); releaseWakeLock(); };
$('pause').onclick = () => { if (!route) return; running = !running; $('pause').textContent = running ? 'Pause' : 'Reprendre'; };
$('stopBtn').onclick = () => {
  if (!route) return; running = false; v = 0; hideDirectionPanel(); $('pause').textContent = 'Repartir'; if (ctl) sendGrade(0);
  $('stopInfo').textContent = `Sortie : ${(totalDistance / 1000).toFixed(2)} km · ${Math.round(kcal)} kcal.`;
  $('stopDialog').classList.remove('hide');
};
$('resumeStop').onclick = () => { $('stopDialog').classList.add('hide'); running = true; last = performance.now(); requestWakeLock(); };
$('quitStop').onclick = () => { running = false; $('stopDialog').classList.add('hide'); $('home').classList.remove('hide'); releaseWakeLock(); };
$('quitBtn').onclick = () => { running = false; releaseWakeLock(); $('home').classList.remove('hide'); };

demo();
requestAnimationFrame(loop);

} catch (error) {
  console.error(error);
  const ft = document.getElementById('fatalText');
  if (ft) ft.textContent = error.message;
  const f = document.getElementById('fatal');
  if (f) f.classList.remove('hide');
}
})();
// FIN DU FICHIER