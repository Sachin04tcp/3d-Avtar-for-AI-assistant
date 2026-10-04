import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { retargetClip } from './Retarget';
import type { RetargetOptions, RetargetResult } from './Retarget';

export interface ClipRequest {
  id: string;
  label: string;
  file: string;
  kind: 'loop' | 'once';
  category: string;
  /** registry-measured motion energy (rad/s) — used for music-dance matching */
  energy: number;
}

export interface ClipBuildResult extends RetargetResult {
  id: string;
  label: string;
  category: string;
  kind: 'loop' | 'once';
  file: string;
  sourceDuration: number;
  energy: number;
}

/**
 * Loads each source FBX, retargets its first animation clip onto the avatar rig,
 * and disposes the intermediate FBX scene. Loads sequentially so progress reporting
 * is simple and the browser isn't fighting itself on parse-heavy work.
 */
export async function buildClips(
  sources: ClipRequest[],
  targetRoot: THREE.Object3D,
  retargetOptions: RetargetOptions,
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<ClipBuildResult[]> {
  const loader = new FBXLoader();
  const results: ClipBuildResult[] = [];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    onProgress?.(i, sources.length, source.label);
    const fbxScene = await loader.loadAsync(source.file);
    const sourceClip = fbxScene.animations[0];
    if (!sourceClip) throw new Error(`No animation clip found in ${source.file}`);

    const retargeted = retargetClip(sourceClip, fbxScene, targetRoot, retargetOptions);
    retargeted.clip.name = source.id;

    results.push({
      ...retargeted,
      id: source.id,
      label: source.label,
      category: source.category,
      kind: source.kind,
      file: source.file,
      sourceDuration: sourceClip.duration,
      energy: source.energy,
    });

    disposeObject(fbxScene);
  }

  onProgress?.(sources.length, sources.length, 'done');
  return results;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      for (const value of Object.values(mat)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      mat.dispose();
    }
  });
}
