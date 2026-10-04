import * as THREE from 'three';

/**
 * Retargets animation clips authored on a Mixamo skeleton (mixamorig:* bones)
 * onto an arbitrary target rig (here: VRM-style J_Bip_* bones).
 *
 * Approach: for every mapped bone, the source's world-frame relative motion
 * S_world·S_rest⁻¹ is applied on top of the target's rest:
 * T_worldAnim = S_worldAnim · (S_restWorld⁻¹ · T_restWorld).
 * At source rest the target sits exactly at its own rest, and the target mesh
 * undergoes the same world-space rotation as the source mesh — independent of
 * how differently the two rigs orient their bind bones (e.g. a VRM-style head
 * vs the Mixamo head, ~95° apart here). Hip translation is copied in world space
 * scaled by the ratio of hip heights so centimeter-based Mixamo clips and
 * proportion differences both cancel out.
 *
 * Clips are sampled at a fixed rate and baked into fresh tracks bound to the
 * target bone names, so playback is a plain AnimationMixer on the avatar root.
 */

export interface RetargetOptions {
  /** source bone name -> target bone name */
  boneMap: Map<string, string>;
  /** bake sample rate in fps (default 30) */
  sampleFps?: number;
  /** keep vertical hips motion but remove horizontal travel (default false) */
  inPlace?: boolean;
}

export interface RetargetResult {
  clip: THREE.AnimationClip;
  /** number of source bones successfully mapped */
  mappedBones: number;
  /** source bone names from the map that were not found on the source skeleton */
  missingOnSource: string[];
  /** source animated nodes that had no mapping and were skipped */
  skippedSourceNodes: string[];
}

export function retargetClip(
  sourceClip: THREE.AnimationClip,
  sourceRoot: THREE.Object3D,
  targetRoot: THREE.Object3D,
  opts: RetargetOptions,
): RetargetResult {
  const fps = opts.sampleFps ?? 30;
  const inPlace = opts.inPlace ?? false;
  const duration = sourceClip.duration;
  const frameCount = Math.max(2, Math.ceil(duration * fps) + 1);

  // FBXLoader strips characters like ':' from node names ("mixamorig:Hips" -> "mixamorigHips"),
  // so lookups fall back to a normalized (alphanumeric-only, lowercase) name index.
  const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  const sourceExact = new Map<string, THREE.Object3D>();
  const sourceNorm = new Map<string, THREE.Object3D>();
  const targetExact = new Map<string, THREE.Object3D>();
  const targetNorm = new Map<string, THREE.Object3D>();
  sourceRoot.traverse((o) => {
    sourceExact.set(o.name, o);
    sourceNorm.set(normalize(o.name), o);
  });
  targetRoot.traverse((o) => {
    targetExact.set(o.name, o);
    targetNorm.set(normalize(o.name), o);
  });
  const findSource = (name: string): THREE.Object3D | undefined => sourceExact.get(name) ?? sourceNorm.get(normalize(name));
  const findTarget = (name: string): THREE.Object3D | undefined => targetExact.get(name) ?? targetNorm.get(normalize(name));
  const normBoneMap = new Map<string, string>();
  for (const [srcName, dstName] of opts.boneMap) normBoneMap.set(normalize(srcName), dstName);

  interface Pair {
    src: THREE.Object3D;
    dst: THREE.Object3D;
    /** bake a position track for this bone (Mixamo: only Hips) */
    bakePosition: boolean;
  }

  const missingOnSource: string[] = [];
  const pairs: Pair[] = [];
  for (const [srcName, dstName] of opts.boneMap) {
    const src = findSource(srcName);
    const dst = findTarget(dstName);
    if (!src) {
      missingOnSource.push(srcName);
      continue;
    }
    if (!dst) throw new Error(`Retarget: target rig has no bone "${dstName}" (mapped from "${srcName}")`);
    pairs.push({ src, dst, bakePosition: false });
  }
  if (pairs.length === 0) throw new Error('Retarget: no bones mapped between source clip and target rig');

  // Which mapped bones receive position tracks? (Mixamo animates only the Hips.)
  for (const track of sourceClip.tracks) {
    if (!track.name.endsWith('.position')) continue;
    const nodeName = track.name.slice(0, -'.position'.length);
    const dstName = normBoneMap.get(normalize(nodeName));
    if (!dstName) continue;
    const dst = findTarget(dstName);
    const pair = pairs.find((p) => p.dst === dst);
    if (pair) pair.bakePosition = true;
  }

  // Depth-sort so parents are always processed before children.
  const depthOf = (obj: THREE.Object3D): number => {
    let d = 0;
    for (let o: THREE.Object3D | null = obj; o; o = o.parent) d++;
    return d;
  };
  pairs.sort((a, b) => depthOf(a.dst) - depthOf(b.dst));

  // Rest-pose snapshots (captured before any animation is applied).
  sourceRoot.updateMatrixWorld(true);
  targetRoot.updateMatrixWorld(true);

  // Per-bone rest alignment K = S_restWorld⁻¹ · T_restWorld.
  // Rule: T_worldAnim = S_worldAnim · K — at source rest the target is exactly at
  // its own rest, and the target mesh mirrors the source mesh's world motion.
  const scratchV = new THREE.Vector3();
  const scratchS = new THREE.Vector3();
  const restK = new Map<THREE.Object3D, THREE.Quaternion>();
  for (const pair of pairs) {
    const sRest = new THREE.Quaternion();
    const tRest = new THREE.Quaternion();
    pair.src.matrixWorld.decompose(scratchV, sRest, scratchS);
    pair.dst.matrixWorld.decompose(scratchV, tRest, scratchS);
    restK.set(pair.dst, sRest.invert().multiply(tRest));
  }

  const hipsPair = pairs.find((p) => p.bakePosition) ?? null;
  let hipsRatio = 1;
  let hipsRestXZ: [number, number] = [0, 0];
  if (hipsPair) {
    const srcRest = new THREE.Vector3();
    const dstRest = new THREE.Vector3();
    const tmpQ = new THREE.Quaternion();
    const tmpS = new THREE.Vector3();
    hipsPair.src.matrixWorld.decompose(srcRest, tmpQ, tmpS);
    hipsPair.dst.matrixWorld.decompose(dstRest, tmpQ, tmpS);
    if (srcRest.y > 1e-6) hipsRatio = dstRest.y / srcRest.y;
    hipsRestXZ = [srcRest.x * hipsRatio, srcRest.z * hipsRatio];
  }

  // Per-frame animated world rotation of each mapped target bone (rest-compensated),
  // needed to localize children that are themselves mapped.
  const animatedWorldQ = new Map<THREE.Object3D, THREE.Quaternion>();
  const mappedTargets = new Set(pairs.map((p) => p.dst));
  for (const pair of pairs) animatedWorldQ.set(pair.dst, new THREE.Quaternion());

  // Bake buffers.
  const times = new Float32Array(frameCount);
  const quatData = new Map<THREE.Object3D, Float32Array>();
  const posData = new Map<THREE.Object3D, Float32Array>();
  for (const pair of pairs) {
    quatData.set(pair.dst, new Float32Array(frameCount * 4));
    if (pair.bakePosition) posData.set(pair.dst, new Float32Array(frameCount * 3));
  }

  // Scratch objects (reused per frame/bone).
  const srcPos = new THREE.Vector3();
  const srcQuat = new THREE.Quaternion();
  const srcScale = new THREE.Vector3();
  const parentPos = new THREE.Vector3();
  const parentQuat = new THREE.Quaternion();
  const parentScale = new THREE.Vector3();
  const localQuat = new THREE.Quaternion();
  const worldPos = new THREE.Vector3();
  const parentInv = new THREE.Matrix4();

  const mixer = new THREE.AnimationMixer(sourceRoot);
  mixer.clipAction(sourceClip).play();

  for (let f = 0; f < frameCount; f++) {
    const time = Math.min(duration, f / fps);
    times[f] = time;
    mixer.setTime(time);
    sourceRoot.updateMatrixWorld(true);

    for (const pair of pairs) {
      pair.src.matrixWorld.decompose(srcPos, srcQuat, srcScale);

      // Target world rotation: source world-relative motion on top of target rest.
      const dstWorldQ = animatedWorldQ.get(pair.dst)!;
      dstWorldQ.copy(srcQuat).multiply(restK.get(pair.dst)!);

      // Localize against the target parent's animated world rotation
      // (rest rotation when the parent is unmapped/static).
      const parent = pair.dst.parent!;
      if (mappedTargets.has(parent)) {
        parentQuat.copy(animatedWorldQ.get(parent)!); // depth order guarantees presence
      } else {
        parent.matrixWorld.decompose(parentPos, parentQuat, parentScale);
      }
      localQuat.copy(parentQuat).invert().multiply(dstWorldQ);

      const qArr = quatData.get(pair.dst)!;
      qArr[f * 4 + 0] = localQuat.x;
      qArr[f * 4 + 1] = localQuat.y;
      qArr[f * 4 + 2] = localQuat.z;
      qArr[f * 4 + 3] = localQuat.w;

      if (pair.bakePosition) {
        // Mixamo animates only the Hips translation; its parent is static, so the
        // parent's rest world matrix is exactly its animated matrix.
        worldPos.copy(srcPos).multiplyScalar(hipsRatio);
        if (inPlace) {
          worldPos.x = hipsRestXZ[0];
          worldPos.z = hipsRestXZ[1];
        }
        parentInv.copy(parent.matrixWorld).invert();
        worldPos.applyMatrix4(parentInv);
        const pArr = posData.get(pair.dst)!;
        pArr[f * 3 + 0] = worldPos.x;
        pArr[f * 3 + 1] = worldPos.y;
        pArr[f * 3 + 2] = worldPos.z;
      }
    }
  }

  mixer.stopAllAction();
  mixer.uncacheRoot(sourceRoot);

  // Build tracks with quaternion sign continuity.
  const tracks: THREE.KeyframeTrack[] = [];
  for (const [dst, arr] of quatData) {
    fixQuaternionSigns(arr);
    tracks.push(new THREE.QuaternionKeyframeTrack(`${dst.name}.quaternion`, Array.from(times), Array.from(arr)));
  }
  for (const [dst, arr] of posData) {
    tracks.push(new THREE.VectorKeyframeTrack(`${dst.name}.position`, Array.from(times), Array.from(arr)));
  }

  const skippedSourceNodes = collectUnmappedAnimatedNodes(sourceClip, opts.boneMap);

  return {
    clip: new THREE.AnimationClip(sourceClip.name || 'retargeted', duration, tracks),
    mappedBones: pairs.length,
    missingOnSource,
    skippedSourceNodes,
  };
}

/** Flip successive quaternions that cross the hemisphere boundary so interpolation stays shortest-arc. */
function fixQuaternionSigns(arr: Float32Array): void {
  for (let i = 4; i < arr.length; i += 4) {
    let dot = 0;
    for (let k = 0; k < 4; k++) dot += arr[i + k] * arr[i - 4 + k];
    if (dot < 0) {
      for (let k = 0; k < 4; k++) arr[i + k] = -arr[i + k];
    }
  }
}

function collectUnmappedAnimatedNodes(clip: THREE.AnimationClip, boneMap: Map<string, string>): string[] {
  const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const mappedNorm = new Set([...boneMap.keys()].map(normalize));
  const nodes = new Set<string>();
  for (const track of clip.tracks) {
    const dotAt = track.name.indexOf('.');
    if (dotAt > 0) nodes.add(track.name.slice(0, dotAt));
  }
  const skipped: string[] = [];
  for (const node of nodes) if (!mappedNorm.has(normalize(node))) skipped.push(node);
  return skipped.sort();
}
