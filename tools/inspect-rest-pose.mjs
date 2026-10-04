#!/usr/bin/env node
// Read-only rest-pose analysis of a GLB: computes joint world transforms from node TRS
// to report model height, hips height, arm/leg rest directions (T-pose vs A-pose), and
// the scale of the armature root nodes. No three.js dependency; pure TRS math.
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const buf = readFileSync(path);
if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');
let off = 12;
let json = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.toString('ascii', off + 4, off + 8);
  if (type === 'JSON') json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + len));
  off += 8 + len;
}
const nodes = json.nodes;

// --- column-major 4x4 helpers ---
function quatToMat4(q) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ];
}
function scaleMat4(s) { return [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1]; }
function transMat4(t) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1]; }
function mul4(A, B) {
  const C = new Array(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) C[col * 4 + row] += A[k * 4 + row] * B[col * 4 + k];
  return C;
}
function localMatrix(n) {
  if (n.matrix) return n.matrix.slice();
  return mul4(transMat4(n.translation ?? [0, 0, 0]), mul4(quatToMat4(n.rotation ?? [0, 0, 0, 1]), scaleMat4(n.scale ?? [1, 1, 1])));
}
function applyPoint(M, p) {
  return [0, 1, 2].map((row) => M[0 * 4 + row] * p[0] + M[1 * 4 + row] * p[1] + M[2 * 4 + row] * p[2] + M[3 * 4 + row]);
}

const worlds = new Array(nodes.length);
const roots = json.scenes[json.scene ?? 0].nodes;
for (const r of roots) worlds[r] = localMatrix(nodes[r]);
const stack = [...roots];
while (stack.length) {
  const i = stack.pop();
  for (const c of nodes[i].children ?? []) {
    worlds[c] = mul4(worlds[i], localMatrix(nodes[c]));
    stack.push(c);
  }
}
const byName = new Map(nodes.map((n, i) => [n.name, i]));
const wp = (name) => applyPoint(worlds[byName.get(name)], [0, 0, 0]);

// joint bbox
const skin = json.skins[0];
const pts = skin.joints.map((j) => applyPoint(worlds[j], [0, 0, 0]));
const minY = Math.min(...pts.map((p) => p[1]));
const maxY = Math.max(...pts.map((p) => p[1]));
const hips = wp('J_Bip_C_Hips');
const head = wp('J_Bip_C_Head');
console.log('joint span: minY=%.4f maxY=%.4f height=%.4f', minY, maxY, maxY - minY);
console.log('hips world: %s', hips.map((v) => v.toFixed(4)).join(', '));
console.log('head world: %s', head.map((v) => v.toFixed(4)).join(', '));

// arm direction (T-pose vs A-pose)
function dirOf(a, b) {
  const pa = wp(a), pb = wp(b);
  const d = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
  const len = Math.hypot(...d);
  return [d[0] / len, d[1] / len, d[2] / len, len];
}
for (const [side, S, U] of [['L', 'J_Bip_L_Shoulder', 'J_Bip_L_UpperArm'], ['R', 'J_Bip_R_Shoulder', 'J_Bip_R_UpperArm']]) {
  const [dx, dy, dz, len] = dirOf(S, U);
  const elevation = Math.asin(Math.abs(dy)) * (180 / Math.PI);
  console.log(`UpperArm ${side}: dir=(${dx.toFixed(3)}, ${dy.toFixed(3)}, ${dz.toFixed(3)}) len=${len.toFixed(4)} elevationAboveHorizontal=${elevation.toFixed(1)}°`);
}
for (const side of ['L', 'R']) {
  const [dx, dy, dz, len] = dirOf(`J_Bip_C_Hips`, `J_Bip_${side}_UpperLeg`);
  console.log(`UpperLeg ${side}: dir=(${dx.toFixed(3)}, ${dy.toFixed(3)}, ${dz.toFixed(3)}) len=${len.toFixed(4)}`);
}

// root node TRS
for (const r of roots) {
  const n = nodes[r];
  console.log(`root node "${n.name}": translation=${JSON.stringify(n.translation ?? [0, 0, 0])} rotation=${JSON.stringify(n.rotation ?? [0, 0, 0, 1])} scale=${JSON.stringify(n.scale ?? [1, 1, 1])}`);
}
// meshes: names, skin binding, morphs, material count
console.log('\nmesh nodes:');
for (const n of nodes) {
  if (n.mesh === undefined) continue;
  const m = json.meshes[n.mesh];
  console.log(`  node "${n.name}" mesh "${m.name}" skin=${n.skin ?? '-'} prims=${m.primitives.length}`);
}
