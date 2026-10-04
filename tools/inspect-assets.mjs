#!/usr/bin/env node
// Read-only asset inspector.
// GLB: parses the JSON chunk and reports skeleton joints, animations, morph targets, materials, extensions.
// FBX: reports binary header/version, presence of animation stacks, and Mixamo bone names found in the file.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.';
const files = readdirSync(dir).filter((f) => /\.(glb|gltf|fbx)$/i.test(f));

function inspectGlb(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB (bad magic)');
  let off = 12;
  let json = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'JSON') json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + len));
    off += 8 + len;
  }
  const counts = {
    nodes: json.nodes?.length ?? 0,
    meshes: json.meshes?.length ?? 0,
    skins: json.skins?.length ?? 0,
    materials: json.materials?.length ?? 0,
    textures: json.textures?.length ?? 0,
    animations: json.animations?.length ?? 0,
  };
  console.log('generator:', json.asset?.generator ?? '(unknown)');
  console.log('glTF version:', json.asset?.version);
  console.log('extensionsUsed:', json.extensionsUsed?.length ? json.extensionsUsed.join(', ') : '(none)');
  console.log('extensionsRequired:', json.extensionsRequired?.length ? json.extensionsRequired.join(', ') : '(none)');
  console.log('counts:', JSON.stringify(counts));

  (json.skins ?? []).forEach((s, i) => {
    const names = s.joints.map((j) => json.nodes[j].name ?? `#${j}`);
    console.log(`\nskin[${i}] "${s.name ?? ''}" — ${s.joints.length} joints:`);
    console.log('  ' + names.join(', '));
  });

  (json.animations ?? []).forEach((a, i) => {
    const paths = [...new Set(a.channels.map((c) => c.target.path))].join(',');
    const nodes = new Set(a.channels.map((c) => c.target.node));
    console.log(`anim[${i}] "${a.name ?? ''}" channels=${a.channels.length} paths=${paths} animatedNodes=${nodes.size}`);
  });

  const morphMeshes = (json.meshes ?? []).filter((m) => (m.primitives ?? []).some((p) => p.targets?.length));
  if (morphMeshes.length) {
    console.log('\nmorph target meshes:');
    for (const m of morphMeshes) {
      const prim = m.primitives.find((p) => p.targets?.length);
      const names = m.extras?.targetNames ?? null;
      console.log(`  "${m.name}" targets=${prim.targets.length} names=${names ? names.join(', ') : '(none in extras)'}`);
    }
  } else {
    console.log('\nmorph target meshes: (none)');
  }

  if (json.materials?.length) {
    console.log('\nmaterials:', json.materials.map((m) => m.name ?? '(unnamed)').join(', '));
  }

  const sceneNodes = json.scenes?.[0]?.nodes ?? [];
  console.log('\nscene root nodes:', sceneNodes.map((n) => json.nodes[n].name ?? `#${n}`).join(', '));

  // --- Phase 3 additions: VRM / face-rig summary ---
  const exts = [...(json.extensionsUsed ?? []), ...Object.keys(json.extensions ?? {})];
  const vrmExts = exts.filter((e) => /VRM/i.test(e));
  console.log('\n--- GLB summary ---');
  console.log('isVRM:', vrmExts.length > 0 ? `yes (${vrmExts.join(', ')})` : 'no — plain glTF 2.0 with VRM-style J_Bip_* bone names');
  const jointNames = (json.skins?.[0]?.joints ?? []).map((j) => json.nodes[j].name ?? '');
  const eyeBones = jointNames.filter((n) => /eye/i.test(n));
  const jawBones = jointNames.filter((n) => /jaw/i.test(n));
  console.log('eye bones:', eyeBones.length ? eyeBones.join(', ') : '(none)');
  console.log('jaw bones:', jawBones.length ? jawBones.join(', ') : '(none — mouth driven by morphs only)');
  const morphNames = [];
  for (const m of json.meshes ?? []) {
    if (m.extras?.targetNames) morphNames.push(...m.extras.targetNames);
  }
  const mouthMorphs = morphNames.filter((n) => /MTH|mouth/i.test(n));
  const blinkMorphs = morphNames.filter((n) => /EYE_Close|blink/i.test(n));
  console.log('facial morph count:', new Set(morphNames).size);
  console.log('mouth morphs:', mouthMorphs.join(', '));
  console.log('blink morphs:', blinkMorphs.join(', '));
  console.log('embedded animation clips:', json.animations?.length ?? 0);
}

function inspectFbx(path) {
  const buf = readFileSync(path);
  const head = buf.toString('latin1', 0, 21).replace(/[^\x20-\x7e]/g, '.');
  const version = buf.readUInt32LE(23);
  const text = buf.toString('latin1');
  const boneNames = [...new Set(text.match(/mixamorig:[A-Za-z0-9_]+/g) ?? [])];
  const hasAnimStack = text.includes('AnimationStack');
  const hasAnimCurve = text.includes('AnimationCurveNode');
  console.log(`  header="${head}" fbxVersion=${version}`);
  console.log(`  animationStack=${hasAnimStack} animationCurveNode=${hasAnimCurve}`);
  console.log(`  distinct "mixamorig:*" names: ${boneNames.length}`);
  if (boneNames.length) console.log('  ' + boneNames.slice(0, 90).join(', '));
}

for (const f of files) {
  console.log(`\n=== ${f} ===`);
  try {
    if (/\.glb$/i.test(f)) inspectGlb(join(dir, f));
    else inspectFbx(join(dir, f));
  } catch (e) {
    console.error('  ERROR:', e.message);
  }
}
