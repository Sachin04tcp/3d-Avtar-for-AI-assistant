import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface LoadedAvatar {
  /** Normalized wrapper (feet at y=0, centered on x/z) — add this to the scene. */
  root: THREE.Group;
  /** All bones of the first skin found in the model. */
  bones: THREE.Bone[];
  boneNames: Set<string>;
  /** Meshes that carry morph targets (for facial expressions). */
  morphMeshes: THREE.Mesh[];
  /** Model height in meters (rest pose, before any wrapper offset). */
  height: number;
}

/**
 * Loads the GLB avatar, enables shadows, wraps it in a group normalized so the
 * character stands on y=0 and is centered at the origin.
 */
export async function loadAvatar(url: string, onProgress?: (fraction: number) => void): Promise<LoadedAvatar> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url, (event) => {
    if (onProgress && event.total > 0) onProgress(event.loaded / event.total);
  });

  const model = gltf.scene;
  model.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      // VRoid exports often leave roughness at 1.0; a bit of sheen keeps skin/hair from looking flat
      if (mat instanceof THREE.MeshStandardMaterial) {
        mat.envMapIntensity = 0.9;
      }
    }
  });

  const wrapper = new THREE.Group();
  wrapper.name = 'AvatarRoot';
  wrapper.add(model);

  // Normalize: measure rest-pose bounds, then place the wrapper so feet sit on y=0,
  // centered in x/z. Uniform scale is left alone (source is already ~1.5 m in meters).
  const box = new THREE.Box3().setFromObject(model);
  const height = box.max.y - box.min.y;
  wrapper.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);

  const bones: THREE.Bone[] = [];
  const boneNames = new Set<string>();
  const morphMeshes: THREE.Mesh[] = [];
  model.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) {
      bones.push(obj as THREE.Bone);
      boneNames.add(obj.name);
    }
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.morphAttributes?.position?.length) {
      morphMeshes.push(mesh);
    }
  });

  return { root: wrapper, bones, boneNames, morphMeshes, height };
}
