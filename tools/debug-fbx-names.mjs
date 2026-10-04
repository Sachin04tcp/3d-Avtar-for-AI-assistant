// Debug: parse one Mixamo FBX with three's FBXLoader in Node and dump node names + track names.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const file = process.argv[2];
const buf = readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const loader = new FBXLoader();
const group = loader.parse(ab, '');

const lines = [];
group.traverse((o) => lines.push(`${o.type}: "${o.name}"`));
console.log(`--- scene graph (${lines.length} nodes) ---`);
console.log(lines.slice(0, 90).join('\n'));

const clip = group.animations[0];
console.log(`\n--- animation: ${clip ? `${clip.tracks.length} tracks, ${clip.duration.toFixed(2)}s` : 'NONE'} ---`);
if (clip) {
  console.log(clip.tracks.slice(0, 12).map((t) => `${t.name} [${t.constructor.name}]`).join('\n'));
}
