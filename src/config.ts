import registry from './animation-registry.json';

export const MODEL_URL = '/avatar/model/avatar.glb';
export const MODEL_LABEL = 'anux ai 3d model — VRM-style rig (J_Bip_*)';

/** One-shots hold their final pose for this long, then fade back to idle (ms). */
export const ONESHOT_HOLD_MS = 1800;

/** Crossfade duration between clips (seconds). */
export const CROSSFADE_S = 0.35;

/** Sample rate used when baking retargeted clips (fps). */
export const RETARGET_SAMPLE_FPS = 30;

/** Strip horizontal hips travel from clips (keep vertical bounce) so dances stay centered. */
export const IN_PLACE_ROOT_MOTION = true;

/** Bone-name map: Mixamo FBX source bones → this avatar's VRM-style bones. */
export const BONE_MAP: Record<string, string> = {
  'mixamorig:Hips': 'J_Bip_C_Hips',
  'mixamorig:Spine': 'J_Bip_C_Spine',
  'mixamorig:Spine1': 'J_Bip_C_Chest',
  'mixamorig:Spine2': 'J_Bip_C_UpperChest',
  'mixamorig:Neck': 'J_Bip_C_Neck',
  'mixamorig:Head': 'J_Bip_C_Head',

  'mixamorig:LeftShoulder': 'J_Bip_L_Shoulder',
  'mixamorig:LeftArm': 'J_Bip_L_UpperArm',
  'mixamorig:LeftForeArm': 'J_Bip_L_LowerArm',
  'mixamorig:LeftHand': 'J_Bip_L_Hand',
  'mixamorig:LeftUpLeg': 'J_Bip_L_UpperLeg',
  'mixamorig:LeftLeg': 'J_Bip_L_LowerLeg',
  'mixamorig:LeftFoot': 'J_Bip_L_Foot',
  'mixamorig:LeftToeBase': 'J_Bip_L_ToeBase',

  'mixamorig:RightShoulder': 'J_Bip_R_Shoulder',
  'mixamorig:RightArm': 'J_Bip_R_UpperArm',
  'mixamorig:RightForeArm': 'J_Bip_R_LowerArm',
  'mixamorig:RightHand': 'J_Bip_R_Hand',
  'mixamorig:RightUpLeg': 'J_Bip_R_UpperLeg',
  'mixamorig:RightLeg': 'J_Bip_R_LowerLeg',
  'mixamorig:RightFoot': 'J_Bip_R_Foot',
  'mixamorig:RightToeBase': 'J_Bip_R_ToeBase',
};

// Fingers: Mixamo has 4 segments (Thumb/Index/Middle/Ring/Pinky 1–4); this rig has 3
// (Thumb/Index/Middle/Ring/Little 1–3). Map the first three, drop the tips.
for (const [mixSide, vrmSide] of [
  ['Left', 'L'],
  ['Right', 'R'],
] as const) {
  for (const [mixFinger, vrmFinger] of [
    ['Thumb', 'Thumb'],
    ['Index', 'Index'],
    ['Middle', 'Middle'],
    ['Ring', 'Ring'],
    ['Pinky', 'Little'],
  ] as const) {
    for (let i = 1; i <= 3; i++) {
      BONE_MAP[`mixamorig:${mixSide}Hand${mixFinger}${i}`] = `J_Bip_${vrmSide}_${vrmFinger}${i}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Animation registry (generated from the actual FBX files by
// tools/generate-animation-registry.mjs — never hand-edit the entries).
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  id: string;
  name: string;
  file: string;
  category: string;
  kind: 'loop' | 'once';
  duration: number;
  fps: number;
  boneCount: number;
  rootBone: string | null;
  humanoidCompatible: boolean;
  compatible: boolean;
  requiresRetargeting: boolean;
  features: {
    hipsRestY: number;
    hipsYMean: number;
    endDrop: number;
    lowFraction: number;
    hipsXZTravel: number;
    hipsYAmplitude: number;
    energyArms: number;
    energySpine: number;
    energyLegs: number;
    energy: number;
    endAngleDeg: number;
  };
}

const entries = (registry.animations as unknown as RegistryEntry[]).filter((e) => !('error' in e));

/** Clip requests for the loader pipeline, derived 1:1 from the generated registry. */
export const CLIP_SOURCES = entries.map((e) => ({
  id: e.id,
  label: e.name,
  file: e.file,
  kind: e.kind,
  category: e.category,
  energy: e.features.energy,
}));

/** The registry entry used as the resting/default animation. */
export const IDLE_CLIP_ID = entries.find((e) => e.category === 'IDLE')?.id ?? entries[0].id;

export { EMOTION_NAMES } from './avatar/Emotions';
export type { EmotionName } from './avatar/Emotions';
