import type { ExpressionEngine } from './Expressions';

/**
 * Emotion system (Phase 2.6/2.7).
 *
 * Every emotion is a recipe over morph targets that genuinely exist on this
 * model (57 Fcl_* targets — verified by tools/inspect-assets.mjs) plus a set of
 * behavior parameters the idle layer reads (breath rate, sway energy, gaze
 * attention, blink rate, head posture bias). No invented morph names.
 */

export type EmotionName =
  | 'NEUTRAL'
  | 'HAPPY'
  | 'SAD'
  | 'ANGRY'
  | 'SURPRISED'
  | 'CURIOUS'
  | 'THINKING'
  | 'EXCITED'
  | 'CALM'
  | 'PLAYFUL';

export const EMOTION_NAMES: EmotionName[] = [
  'NEUTRAL',
  'HAPPY',
  'SAD',
  'ANGRY',
  'SURPRISED',
  'CURIOUS',
  'THINKING',
  'EXCITED',
  'CALM',
  'PLAYFUL',
];

export interface EmotionParams {
  /** breathing cycles per second */
  breathRate: number;
  /** multiplier on idle sway/posture motion amplitude */
  swayEnergy: number;
  /** 0..1 — how strongly the gaze prefers the camera over wandering */
  gazeCameraBias: number;
  /** multiplier on blink frequency */
  blinkRateMul: number;
  /** resting head pitch bias in degrees (positive = chin down) */
  headPitchBiasDeg: number;
  /** multiplier on idle behavior frequency */
  behaviorEnergy: number;
}

const DEFAULT_PARAMS: EmotionParams = {
  breathRate: 0.22,
  swayEnergy: 1,
  gazeCameraBias: 0.75,
  blinkRateMul: 1,
  headPitchBiasDeg: 0,
  behaviorEnergy: 1,
};

interface EmotionDef {
  morphs: Array<[string, number]>;
  params?: Partial<EmotionParams>;
}

/** Recipes use only morph names present in the GLB (Fcl_* list). */
export const EMOTION_PRESETS: Record<EmotionName, EmotionDef> = {
  NEUTRAL: { morphs: [] },
  HAPPY: { morphs: [['Fcl_ALL_Joy', 0.85]], params: { swayEnergy: 1.25, gazeCameraBias: 0.85, blinkRateMul: 1.1 } },
  SAD: {
    morphs: [['Fcl_ALL_Sorrow', 0.9]],
    params: { swayEnergy: 0.5, gazeCameraBias: 0.5, blinkRateMul: 0.75, headPitchBiasDeg: 5, behaviorEnergy: 0.5 },
  },
  ANGRY: {
    morphs: [['Fcl_ALL_Angry', 0.9]],
    params: { swayEnergy: 0.8, gazeCameraBias: 0.9, blinkRateMul: 0.7, headPitchBiasDeg: 2, behaviorEnergy: 0.6 },
  },
  SURPRISED: { morphs: [['Fcl_ALL_Surprised', 0.75], ['Fcl_EYE_Spread', 0.6]], params: { blinkRateMul: 1.3 } },
  CURIOUS: {
    morphs: [['Fcl_BRW_Surprised', 0.7], ['Fcl_EYE_Spread', 0.35], ['Fcl_MTH_Small', 0.5]],
    params: { gazeCameraBias: 0.45, behaviorEnergy: 1.2 },
  },
  THINKING: {
    morphs: [['Fcl_BRW_Sorrow', 0.55], ['Fcl_MTH_Small', 0.6], ['Fcl_EYE_Spread', 0.15]],
    params: { gazeCameraBias: 0.3, swayEnergy: 0.6, behaviorEnergy: 0.7, blinkRateMul: 0.8 },
  },
  EXCITED: {
    morphs: [['Fcl_ALL_Joy', 0.9], ['Fcl_EYE_Spread', 0.55], ['Fcl_MTH_Large', 0.6]],
    params: { breathRate: 0.34, swayEnergy: 1.6, blinkRateMul: 1.4, behaviorEnergy: 1.5 },
  },
  CALM: {
    morphs: [['Fcl_EYE_Close', 0.12], ['Fcl_MTH_Neutral', 0.3]],
    params: { breathRate: 0.16, swayEnergy: 0.7, blinkRateMul: 0.9, behaviorEnergy: 0.7 },
  },
  PLAYFUL: {
    morphs: [['Fcl_ALL_Fun', 0.8], ['Fcl_EYE_Spread', 0.3]],
    params: { swayEnergy: 1.3, gazeCameraBias: 0.75, behaviorEnergy: 1.35 },
  },
};

export class EmotionSystem {
  private engine: ExpressionEngine;
  current: EmotionName = 'NEUTRAL';

  /** Smoothed behavior parameters the idle layer reads every frame. */
  params: EmotionParams = { ...DEFAULT_PARAMS };
  private targetParams: EmotionParams = { ...DEFAULT_PARAMS };

  private overlayMorphs: Array<[string, number]> | null = null;
  private overlayUntil = 0;
  private clock = 0;

  constructor(engine: ExpressionEngine) {
    this.engine = engine;
    this.engine.setTargets(EMOTION_PRESETS.NEUTRAL.morphs);
  }

  setEmotion(name: EmotionName): void {
    const def = EMOTION_PRESETS[name] ?? EMOTION_PRESETS.NEUTRAL;
    this.current = name;
    this.targetParams = { ...DEFAULT_PARAMS, ...def.params };
    this.recomputeTargets();
  }

  /** Temporary morph overlay (smile flickers, reaction faces) merged over the emotion base. */
  setOverlay(morphs: Array<[string, number]>, durationS: number): void {
    this.overlayMorphs = morphs;
    this.overlayUntil = this.clock + durationS;
    this.recomputeTargets();
  }

  update(dt: number): void {
    this.clock += dt;
    if (this.overlayMorphs && this.clock > this.overlayUntil) {
      this.overlayMorphs = null;
      this.recomputeTargets();
    }
    const k = 1 - Math.exp(-dt * 2.2);
    for (const key of Object.keys(DEFAULT_PARAMS) as Array<keyof EmotionParams>) {
      this.params[key] += (this.targetParams[key] - this.params[key]) * k;
    }
    this.engine.update(dt);
  }

  private recomputeTargets(): void {
    const base = EMOTION_PRESETS[this.current].morphs;
    if (!this.overlayMorphs) {
      this.engine.setTargets(base);
      return;
    }
    const merged = new Map(base);
    for (const [name, weight] of this.overlayMorphs) {
      merged.set(name, Math.max(merged.get(name) ?? 0, weight));
    }
    this.engine.setTargets([...merged.entries()]);
  }
}
