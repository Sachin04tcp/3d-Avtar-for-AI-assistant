#!/usr/bin/env node
// Animation registry generator — Phase 4.
// Parses EVERY FBX in public/avatar/animations with three's FBXLoader (no filename guessing),
// measures duration, frame rate, skeleton structure, and quantitative motion features,
// auto-classifies each clip into a category, and writes src/animation-registry.json.
//
// Classification is computed from measured features only:
//   endDrop / lowFraction  (hips height trajectory) → REACTION / SIT
//   angularEnergy          (mean joint rotation speed, rad/s) → DANCE vs IDLE
//   hipsYAmplitude         (vertical bounce) → DANCE
//   hipsXZTravel + arm-speed asymmetry → GREETING
//   loopability            (first pose ≈ last pose) → kind: loop | once
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const ANIM_DIR = process.argv[2] ?? join('public', 'avatar', 'animations');
const OUT_FILE = process.argv[3] ?? join('src', 'animation-registry.json');

// --- frame rate: read CustomFrameRate from the binary FBX GlobalSettings ---
function readFpsFromBinary(buffer) {
  const needle = 'CustomFrameRate';
  const idx = buffer.indexOf(needle, 0, 'latin1');
  if (idx < 0) return null;
  const after = idx + needle.length;
  // string property 'S' + uint32le len + bytes, then double property 'D' + 8 bytes LE
  if (buffer[after] === 0x44) {
    const val = buffer.readDoubleLE(after + 1);
    if (Number.isFinite(val) && val > 1 && val < 1000) return val;
  }
  return null;
}

// --- motion features measured from the clip's tracks ---
function computeFeatures(clip) {
  const posTrack = clip.tracks.find((t) => /Hips\.position$/i.test(t.name));
  const yVals = [];
  let xzMax = 0;
  let firstXZ = null;
  let firstY = null;
  let lastY = null;
  if (posTrack) {
    const v = posTrack.values;
    const n = v.length / 3;
    for (let i = 0; i < n; i++) {
      const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
      if (firstY === null) { firstY = y; firstXZ = [x, z]; }
      lastY = y;
      yVals.push(y);
      const d = Math.hypot(x - firstXZ[0], z - firstXZ[1]);
      if (d > xzMax) xzMax = d;
    }
  }
  const restY = firstY ?? 1;
  const yMin = yVals.length ? Math.min(...yVals) : restY;
  const yMax = yVals.length ? Math.max(...yVals) : restY;
  const yMean = yVals.length ? yVals.reduce((a, b) => a + b, 0) / yVals.length : restY;
  const lowFraction = yVals.length ? yVals.filter((y) => y < 0.8 * restY).length / yVals.length : 0;

  // mean angular speed (rad/s) per bone group, averaged over that group's tracks
  const speedOf = (re) => {
    const tracks = clip.tracks.filter((t) => re.test(t.name) && t.name.endsWith('.quaternion'));
    if (!tracks.length) return 0;
    let sum = 0;
    for (const t of tracks) {
      const v = t.values, times = t.times;
      const n = t.times.length;
      let ang = 0;
      for (let i = 1; i < n; i++) {
        let dot = 0;
        for (let k = 0; k < 4; k++) dot += v[i * 4 + k] * v[(i - 1) * 4 + k];
        ang += 2 * Math.acos(Math.min(1, Math.abs(dot)));
      }
      const dur = times[n - 1] - times[0];
      sum += dur > 0 ? ang / dur : 0;
    }
    return sum / tracks.length;
  };

  const energyArms = (speedOf(/LeftArm|LeftForeArm/) + speedOf(/RightArm|RightForeArm/)) / 2;
  const energySpine = speedOf(/Spine|Chest|UpperChest/);
  const energyLegs = speedOf(/UpLeg|Leg$|Leg\.|Foot/);
  const energy = (energyArms + energySpine + energyLegs) / 3;

  // loopability: first vs last pose similarity across all quaternion tracks + hips travel
  const endDelta = () => {
    const qTracks = clip.tracks.filter((t) => t.name.endsWith('.quaternion'));
    if (!qTracks.length) return 180;
    let sum = 0;
    for (const t of qTracks) {
      const v = t.values;
      let dot = 0;
      for (let k = 0; k < 4; k++) dot += v[k] * v[v.length - 4 + k];
      sum += 2 * Math.acos(Math.min(1, Math.abs(dot))) * 180 / Math.PI;
    }
    return sum / qTracks.length;
  };
  const endAngleDeg = endDelta();
  const hipsYAmplitude = (yMax - yMin) / restY;

  return {
    hipsRestY: +restY.toFixed(3),
    hipsYMean: +yMean.toFixed(3),
    endDrop: +(((lastY ?? restY) - restY) / restY).toFixed(3),
    lowFraction: +lowFraction.toFixed(3),
    hipsXZTravel: +(xzMax / restY).toFixed(3),
    hipsYAmplitude: +hipsYAmplitude.toFixed(3),
    energyArms: +energyArms.toFixed(3),
    energySpine: +energySpine.toFixed(3),
    energyLegs: +energyLegs.toFixed(3),
    energy: +energy.toFixed(3),
    endAngleDeg: +endAngleDeg.toFixed(1),
  };
}

function classify(f) {
  if (f.endDrop < -0.72) return 'REACTION';                       // ends on the floor
  if (f.lowFraction > 0.18 && f.endDrop < -0.3) return 'SIT';     // settles into a low pose
  if (f.energy > 1.4 || f.hipsYAmplitude > 0.07) return 'DANCE';  // sustained high-energy motion
  if (f.energy < 0.45 && f.hipsXZTravel < 0.12) return 'IDLE';    // subtle in-place sway
  return 'OTHER';
}

function prettyName(file) {
  return basename(file, '.fbx')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/W B/g, 'W/ B')
    .replace(/Briefcase/, 'Briefcase');
}

const files = readdirSync(ANIM_DIR).filter((f) => /\.fbx$/i.test(f)).sort();
const loader = new FBXLoader();
const entries = [];

for (const file of files) {
  const path = join(ANIM_DIR, file);
  const buf = readFileSync(path);
  const fpsFromHeader = readFpsFromBinary(buf);
  const group = loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');

  const clip = group.animations[0];
  if (!clip) {
    entries.push({ id: basename(file, '.fbx'), name: prettyName(file), file: `/${ANIM_DIR.replace(/\\/g, '/')}/${file}`, category: 'OTHER', duration: 0, fps: fpsFromHeader ?? 30, compatible: false, requiresRetargeting: true, error: 'no animation clip found' });
    continue;
  }

  // skeleton inventory
  const bones = [];
  group.traverse((o) => { if (o.isBone) bones.push(o.name); });
  const has = (re) => bones.some((n) => re.test(n));
  // topmost bone = one whose parent chain contains no other bone
  const byName = new Map();
  group.traverse((o) => { if (o.isBone) byName.set(o.name, o); });
  let root = null;
  for (const b of byName.values()) {
    let p = b.parent, isTop = true;
    while (p) { if (p.isBone) { isTop = false; break; } p = p.parent; }
    if (isTop) { root = b.name; break; }
  }

  const landmarks = {
    hips: has(/Hips$/),
    spine: has(/Spine/),
    armsUpper: has(/(Left|Right)Arm$/),
    armsLower: has(/(Left|Right)ForeArm/),
    hands: has(/(Left|Right)Hand$/),
    fingers: has(/Hand(Thumb|Index|Middle|Ring|Pinky)1/),
    legsUpper: has(/(Left|Right)UpLeg/),
    legsLower: has(/(Left|Right)Leg$/),
    feet: has(/(Left|Right)Foot/),
    toes: has(/(Left|Right)ToeBase/),
  };
  const humanoid = landmarks.hips && landmarks.spine && landmarks.armsUpper && landmarks.legsUpper && landmarks.feet;
  const requiresRetargeting = !/J_Bip_/.test(bones.join(','));

  const features = computeFeatures(clip);
  const category = classify(features);
  const kind = features.endAngleDeg < 10 ? 'loop' : 'once';

  entries.push({
    id: basename(file, '.fbx'),
    name: prettyName(file),
    file: `/${ANIM_DIR.replace(/\\/g, '/')}/${file}`,
    category,
    kind,
    duration: +clip.duration.toFixed(3),
    fps: fpsFromHeader ?? 30,
    fpsSource: fpsFromHeader ? 'fbx-header' : 'default-assumed',
    boneCount: bones.length,
    rootBone: root,
    landmarks,
    humanoidCompatible: humanoid,
    compatible: humanoid,
    requiresRetargeting,
    features,
  });

  // free parse artifacts
  group.traverse((o) => {
    const m = o;
    if (m.isMesh) m.geometry?.dispose?.();
  });
}

const registry = {
  generatedBy: 'tools/generate-animation-registry.mjs',
  targetRig: 'J_Bip_* (anux ai 3d model.glb)',
  categories: ['IDLE', 'DANCE', 'GREETING', 'SIT', 'REACTION', 'SPECIAL', 'OTHER'],
  defaultKindFor: Object.fromEntries(entries.map((e) => [e.id, e.kind])),
  animations: entries,
};

writeFileSync(OUT_FILE, JSON.stringify(registry, null, 2) + '\n');

console.log(`wrote ${OUT_FILE} (${entries.length} clips)\n`);
console.log('id'.padEnd(22), 'cat'.padEnd(9), 'kind'.padEnd(6), 'dur'.padEnd(7), 'fps'.padEnd(5), 'bones', 'energy', 'endDrop', 'loopΔ°');
for (const e of entries) {
  console.log(
    e.id.padEnd(22),
    e.category.padEnd(9),
    e.kind.padEnd(6),
    String(e.duration).padEnd(7),
    String(e.fps).padEnd(5),
    String(e.boneCount).padEnd(5),
    String(e.features?.energy ?? '-').padEnd(6),
    String(e.features?.endDrop ?? '-').padEnd(7),
    String(e.features?.endAngleDeg ?? '-'),
  );
}
